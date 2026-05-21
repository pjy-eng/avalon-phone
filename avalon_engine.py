from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import random
from typing import Any, Dict, List, Optional


class Role(str, Enum):
    MERLIN = "梅林"
    PERCIVAL = "派西维尔"
    LOYAL = "忠臣"
    MORGANA = "莫甘娜"
    ASSASSIN = "刺客"
    MORDRED = "莫德雷德"
    OBERON = "奥伯伦"


GOOD_ROLES = {Role.MERLIN, Role.PERCIVAL, Role.LOYAL}
EVIL_ROLES = {Role.MORGANA, Role.ASSASSIN, Role.MORDRED, Role.OBERON}


CONFIG: Dict[int, Dict[str, Any]] = {
    5: {"roles": [Role.MERLIN, Role.PERCIVAL, Role.LOYAL, Role.MORGANA, Role.ASSASSIN], "mission_sizes": [2, 3, 2, 3, 3]},
    6: {"roles": [Role.MERLIN, Role.PERCIVAL, Role.LOYAL, Role.LOYAL, Role.MORGANA, Role.ASSASSIN], "mission_sizes": [2, 3, 4, 3, 4]},
    7: {"roles": [Role.MERLIN, Role.PERCIVAL, Role.LOYAL, Role.LOYAL, Role.MORGANA, Role.ASSASSIN, Role.OBERON], "mission_sizes": [2, 3, 3, 4, 4]},
    8: {"roles": [Role.MERLIN, Role.PERCIVAL, Role.LOYAL, Role.LOYAL, Role.LOYAL, Role.MORGANA, Role.ASSASSIN, Role.MORDRED], "mission_sizes": [3, 4, 4, 5, 5]},
    9: {"roles": [Role.MERLIN, Role.PERCIVAL, Role.LOYAL, Role.LOYAL, Role.LOYAL, Role.LOYAL, Role.MORGANA, Role.ASSASSIN, Role.MORDRED], "mission_sizes": [3, 4, 4, 5, 5]},
    10: {"roles": [Role.MERLIN, Role.PERCIVAL, Role.LOYAL, Role.LOYAL, Role.LOYAL, Role.LOYAL, Role.MORGANA, Role.ASSASSIN, Role.MORDRED, Role.OBERON], "mission_sizes": [3, 4, 4, 5, 5]},
}


class Phase(str, Enum):
    LOBBY = "LOBBY"
    NIGHT_ROLE_DISTRIBUTION = "NIGHT_ROLE_DISTRIBUTION"
    # 组队前发言：每轮一开始先有轮流发言，再有公共麦克风，随后队长选人。
    DISCUSSION_ORDERED = "DISCUSSION_ORDERED"
    DISCUSSION_FREE = "DISCUSSION_FREE"
    TEAM_PROPOSAL = "TEAM_PROPOSAL"
    TEAM_VOTE = "TEAM_VOTE"
    MISSION_VOTE = "MISSION_VOTE"
    # 任务结果公布后开放麦克风，让玩家围绕本轮结果复盘，再由房主进入下一轮。
    MISSION_RESULT_DISCUSSION = "MISSION_RESULT_DISCUSSION"
    # 保留旧阶段名，避免旧客户端或测试报错；v3 正常流程不再使用这两个阶段。
    MISSION_DISCUSSION_ORDERED = "MISSION_DISCUSSION_ORDERED"
    MISSION_DISCUSSION_FREE = "MISSION_DISCUSSION_FREE"
    ASSASSINATION_DISCUSSION = "ASSASSINATION_DISCUSSION"
    GAME_OVER = "GAME_OVER"


@dataclass
class PlayerPublic:
    id: str
    name: str
    seat: int
    connected: bool = True


@dataclass
class AvalonGame:
    player_order: List[str]
    player_names: Dict[str, str]
    rng_seed: Optional[int] = None
    roles: Dict[str, Role] = field(default_factory=dict)
    round: int = 1
    leader_index: int = 0
    current_team: List[str] = field(default_factory=list)
    required_team_size: int = 0
    score_good: int = 0
    score_evil: int = 0
    failed_proposals: int = 0
    current_phase: Phase = Phase.LOBBY
    active_speaker: Optional[str] = None
    speaker_queue: List[str] = field(default_factory=list)
    team_votes: Dict[str, str] = field(default_factory=dict)
    mission_votes: Dict[str, str] = field(default_factory=dict)
    mission_result_history: List[Dict[str, Any]] = field(default_factory=list)
    team_vote_history: List[Dict[str, Any]] = field(default_factory=list)
    public_announcement: str = "等待玩家加入圆桌。"
    public_result: Optional[Dict[str, Any]] = None
    winner: Optional[str] = None
    error_message: Optional[str] = None

    def __post_init__(self) -> None:
        if not 5 <= len(self.player_order) <= 10:
            raise ValueError("阿瓦隆人数必须为 5-10 人。")
        self.required_team_size = CONFIG[len(self.player_order)]["mission_sizes"][0]

    @property
    def player_count(self) -> int:
        return len(self.player_order)

    @property
    def leader_id(self) -> str:
        return self.player_order[self.leader_index % self.player_count]

    def seat_of(self, player_id: str) -> int:
        return self.player_order.index(player_id) + 1

    def label_of(self, player_id: Optional[str]) -> Optional[str]:
        if player_id is None:
            return None
        if player_id not in self.player_order:
            return player_id
        return f"Player_{self.seat_of(player_id)}"

    def display_of(self, player_id: Optional[str]) -> Optional[str]:
        if player_id is None:
            return None
        label = self.label_of(player_id)
        name = self.player_names.get(player_id, label or player_id)
        return f"{self.seat_of(player_id)}号-{name}"

    def _advance_leader(self) -> None:
        self.leader_index = (self.leader_index + 1) % self.player_count

    def _round_phase_name(self, phase: Phase) -> str:
        if phase == Phase.DISCUSSION_ORDERED:
            return f"ROUND_{self.round}_PRE_TEAM_DISCUSSION_ORDERED"
        if phase == Phase.DISCUSSION_FREE:
            return f"ROUND_{self.round}_PRE_TEAM_DISCUSSION_FREE"
        if phase == Phase.TEAM_PROPOSAL:
            return f"ROUND_{self.round}_TEAM_PROPOSAL_OPEN_MIC"
        if phase == Phase.TEAM_VOTE:
            return f"ROUND_{self.round}_TEAM_VOTE"
        if phase == Phase.MISSION_VOTE:
            return f"ROUND_{self.round}_MISSION_VOTE"
        if phase == Phase.MISSION_RESULT_DISCUSSION:
            return f"ROUND_{self.round}_MISSION_RESULT_DISCUSSION"
        if phase == Phase.MISSION_DISCUSSION_ORDERED:
            return f"ROUND_{self.round}_PRE_MISSION_DISCUSSION_ORDERED"
        if phase == Phase.MISSION_DISCUSSION_FREE:
            return f"ROUND_{self.round}_PRE_MISSION_DISCUSSION_FREE"
        return phase.value

    def start(self) -> None:
        roles = CONFIG[self.player_count]["roles"][:]
        rng = random.Random(self.rng_seed)
        rng.shuffle(roles)
        self.roles = {pid: roles[i] for i, pid in enumerate(self.player_order)}
        self.round = 1
        self.leader_index = rng.randrange(self.player_count)
        self.current_team = []
        self.required_team_size = CONFIG[self.player_count]["mission_sizes"][0]
        self.score_good = 0
        self.score_evil = 0
        self.failed_proposals = 0
        self.team_votes = {}
        self.mission_votes = {}
        self.mission_result_history = []
        self.team_vote_history = []
        self.winner = None
        self.public_result = None
        self.error_message = None
        self._enter_team_proposal_open_mic(
            prefix=(
                "🌙 天黑请闭眼。身份已经私密分发。第一轮远征即将启程，"
                f"随机产生的当前队长是 {self.display_of(self.leader_id)}。"
            )
        )

    def _enter_pre_team_ordered(self, prefix: str = "") -> None:
        self.current_phase = Phase.DISCUSSION_ORDERED
        self.current_team = []
        self.team_votes = {}
        self.mission_votes = {}
        self.speaker_queue = self._speaker_order_from_leader()
        self.active_speaker = self.speaker_queue[0]
        opener = f"{prefix} " if prefix else ""
        self.public_announcement = (
            f"{opener}现在进入组队前轮流发言阶段。"
            f"当前发言人：{self.display_of(self.active_speaker)}。"
            f"本轮队长稍后需要选择 {self.required_team_size} 名玩家出征。"
            "其余玩家麦克风关闭，但文字公屏开放。"
        )

    def _enter_team_proposal_open_mic(self, prefix: str = "") -> None:
        self.current_phase = Phase.TEAM_PROPOSAL
        self.current_team = []
        self.team_votes = {}
        self.mission_votes = {}
        self.active_speaker = None
        self.speaker_queue = []
        opener = f"{prefix} " if prefix else ""
        self.public_announcement = (
            f"{opener}现在直接进入公麦选人阶段。当前队长是 {self.display_of(self.leader_id)}，"
            f"本轮需要选择 {self.required_team_size} 名玩家出征。"
            "所有玩家麦克风开放，文字公屏开放；队长选完后将进入组队投票。"
        )

    def select_team(self, leader_id: str, team: List[str]) -> None:
        self._clear_error()
        self._require_phase(Phase.TEAM_PROPOSAL)
        if leader_id != self.leader_id:
            raise ValueError(f"当前队长是 {self.display_of(self.leader_id)}，不是 {self.display_of(leader_id)}。")
        if len(team) != self.required_team_size:
            raise ValueError(f"本轮必须选择 {self.required_team_size} 名玩家出征。")
        if len(set(team)) != len(team):
            raise ValueError("队伍中不能出现重复玩家。")
        for pid in team:
            if pid not in self.player_order:
                raise ValueError("队伍包含不存在的玩家。")
        self.current_team = team[:]
        self.team_votes = {}
        self.active_speaker = None
        self.speaker_queue = []
        self.current_phase = Phase.TEAM_VOTE
        team_text = "、".join(self.display_of(pid) or pid for pid in team)
        self.public_announcement = (
            f"🗳️ 队长已经提交队伍：{team_text}。现在直接进入组队投票。"
            "请所有玩家同时选择赞成或反对。投票阶段全员禁麦，但文字公屏开放。"
        )

    def speaker_finished(self, player_id: str, force: bool = False) -> None:
        self._clear_error()
        if self.current_phase not in {Phase.DISCUSSION_ORDERED, Phase.MISSION_DISCUSSION_ORDERED}:
            raise ValueError(f"当前阶段是 {self.current_phase.value}，不能执行该操作。")
        ordered_phase = self.current_phase
        if not force and player_id != self.active_speaker:
            raise ValueError(f"当前发言人是 {self.display_of(self.active_speaker)}，不是 {self.display_of(player_id)}。")
        if not self.speaker_queue:
            self._enter_free_discussion_after_ordered(ordered_phase)
            return
        if self.active_speaker in self.speaker_queue:
            self.speaker_queue.remove(self.active_speaker)
        if self.speaker_queue:
            self.active_speaker = self.speaker_queue[0]
            self.public_announcement = (
                f"🎙️ 发言权交接。当前发言人：{self.display_of(self.active_speaker)}。"
                "其他玩家继续保持禁麦，但文字聊天开放。"
            )
        else:
            self._enter_free_discussion_after_ordered(ordered_phase)

    def _enter_free_discussion_after_ordered(self, ordered_phase: Phase) -> None:
        self.active_speaker = None
        if ordered_phase == Phase.MISSION_DISCUSSION_ORDERED:
            self.current_phase = Phase.MISSION_DISCUSSION_FREE
            team_text = "、".join(self.display_of(pid) or pid for pid in self.current_team)
            self.public_announcement = (
                f"🔥 出征前轮流发言结束。即将上船的队伍是：{team_text}。"
                "现在进入出征前自由辩论阶段，所有玩家麦克风开放，文字聊天开放。"
            )
        else:
            self.current_phase = Phase.DISCUSSION_FREE
            self.public_announcement = (
                "🔥 组队前轮流发言结束。现在进入公共麦克风自由讨论阶段。"
                "所有玩家都可以开麦与打字。队长结束讨论后，将进入选人阶段。"
            )

    def finish_free_discussion(self) -> None:
        self._clear_error()
        if self.current_phase == Phase.DISCUSSION_FREE:
            self.current_phase = Phase.TEAM_PROPOSAL
            self.active_speaker = None
            self.speaker_queue = []
            self.current_team = []
            self.public_announcement = (
                f"🛡️ 自由讨论结束。现在进入队长选人阶段。当前队长是 {self.display_of(self.leader_id)}，"
                f"本轮需要选择 {self.required_team_size} 名玩家出征。"
                "此阶段麦克风继续开放，队长选完后将直接进入组队投票。"
            )
        elif self.current_phase == Phase.MISSION_DISCUSSION_FREE:
            self.current_phase = Phase.MISSION_VOTE
            self.mission_votes = {}
            team_text = "、".join(self.display_of(pid) or pid for pid in self.current_team)
            self.public_announcement = (
                f"🚩 出征前自由讨论结束。远征队伍正式上船：{team_text}。"
                "请所有出征玩家秘密提交任务票。此阶段全员禁麦，但文字公屏开放。"
            )
        else:
            raise ValueError(f"当前阶段是 {self.current_phase.value}，不能结束自由讨论。")

    def submit_team_vote(self, player_id: str, vote: str) -> None:
        self._clear_error()
        self._require_phase(Phase.TEAM_VOTE)
        if player_id not in self.player_order:
            raise ValueError("未知玩家不能投票。")
        if vote not in {"Approve", "Reject"}:
            raise ValueError("组队投票只能是 Approve 或 Reject。")
        self.team_votes[player_id] = vote
        if len(self.team_votes) == self.player_count:
            self._resolve_team_vote()
        else:
            remaining = self.player_count - len(self.team_votes)
            self.public_announcement = f"🗳️ 已收到 {len(self.team_votes)}/{self.player_count} 张组队票。还剩 {remaining} 名玩家未投票。"

    def submit_mission_vote(self, player_id: str, vote: str) -> None:
        self._clear_error()
        self._require_phase(Phase.MISSION_VOTE)
        if player_id not in self.current_team:
            raise ValueError("只有本轮出征队员可以提交任务票。")
        if vote not in {"Success", "Fail"}:
            raise ValueError("任务票只能是 Success 或 Fail。")
        # 体验版规则：所有出征玩家都显示并可提交 Success / Fail。
        self.mission_votes[player_id] = vote
        if len(self.mission_votes) == len(self.current_team):
            self._resolve_mission_vote()
        else:
            remaining = len(self.current_team) - len(self.mission_votes)
            self.public_announcement = f"🚩 已收到 {len(self.mission_votes)}/{len(self.current_team)} 张任务票。还剩 {remaining} 名出征玩家未提交。"

    def continue_after_mission_result(self) -> None:
        self._clear_error()
        self._require_phase(Phase.MISSION_RESULT_DISCUSSION)
        completed_round = self.round
        self._advance_leader()
        self.round += 1
        self.failed_proposals = 0
        self.current_team = []
        self.required_team_size = CONFIG[self.player_count]["mission_sizes"][self.round - 1]
        self.public_result = None
        self._enter_pre_team_ordered(
            prefix=(
                f"第 {completed_round} 轮任务复盘结束。第 {self.round} 轮即将开始，"
                f"新的队长是 {self.display_of(self.leader_id)}。"
            )
        )

    def submit_assassin_target(self, assassin_id: str, target_id: str) -> None:
        self._clear_error()
        self._require_phase(Phase.ASSASSINATION_DISCUSSION)
        if self.roles.get(assassin_id) != Role.ASSASSIN:
            raise ValueError("只有刺客可以提交最终刺杀目标。")
        if target_id not in self.player_order:
            raise ValueError("刺杀目标不是本局玩家。")
        if self.roles.get(target_id) == Role.MERLIN:
            self.winner = "evil"
            self.public_announcement = (
                f"🗡️ 匕首穿过夜色，刺客选择了 {self.display_of(target_id)}。"
                "真正的梅林被刺中。即使任务已经完成，王国也失去了它最关键的智者。邪恶阵营翻盘获胜。"
            )
        else:
            self.winner = "good"
            self.public_announcement = (
                f"👑 刺客选择了 {self.display_of(target_id)}，但他刺错了人。"
                "梅林的智慧得以隐藏到最后。正义阵营获胜。"
            )
        self.current_phase = Phase.GAME_OVER
        self.public_result = {"type": "assassination", "target": self.display_of(target_id), "winner": self.winner}

    def can_chat(self, player_id: str) -> bool:
        return self.current_phase in {
            Phase.LOBBY,
            Phase.DISCUSSION_ORDERED,
            Phase.DISCUSSION_FREE,
            Phase.TEAM_PROPOSAL,
            Phase.TEAM_VOTE,
            Phase.MISSION_VOTE,
            Phase.MISSION_RESULT_DISCUSSION,
            Phase.MISSION_DISCUSSION_ORDERED,
            Phase.MISSION_DISCUSSION_FREE,
            Phase.ASSASSINATION_DISCUSSION,
            Phase.GAME_OVER,
        }

    def private_info_for(self, player_id: str) -> Dict[str, Any]:
        if player_id not in self.roles:
            return {}
        role = self.roles[player_id]
        side = "good" if role in GOOD_ROLES else "evil"
        data: Dict[str, Any] = {
            "role": role.value,
            "side": side,
            "role_message": f"你的身份是：{role.value}。你属于{'正义阵营' if side == 'good' else '邪恶阵营'}。",
            "visible_players": [],
            "visibility_note": "",
        }
        if role == Role.MERLIN:
            visible = [pid for pid, r in self.roles.items() if r in EVIL_ROLES and r != Role.MORDRED]
            data["visible_players"] = [self._player_private_brief(pid) for pid in visible]
            data["visibility_note"] = "你看见的邪恶阵营玩家如下；莫德雷德不会出现在你的视野中。"
        elif role == Role.PERCIVAL:
            candidates = [pid for pid, r in self.roles.items() if r in {Role.MERLIN, Role.MORGANA}]
            data["visible_players"] = [self._player_private_brief(pid) for pid in sorted(candidates, key=self.seat_of)]
            data["visibility_note"] = "你看到两名疑似梅林的玩家，但无法分辨谁是真梅林、谁是莫甘娜。"
        elif role in EVIL_ROLES:
            if role == Role.OBERON:
                data["visible_players"] = []
                data["visibility_note"] = "你是奥伯伦。你不知道其他邪恶阵营是谁，其他邪恶阵营也不知道你。"
            else:
                visible = [pid for pid, r in self.roles.items() if pid != player_id and r in EVIL_ROLES and r != Role.OBERON]
                data["visible_players"] = [self._player_private_brief(pid) for pid in sorted(visible, key=self.seat_of)]
                data["visibility_note"] = "你知道的邪恶队友如下；奥伯伦不会出现在你的视野中。"
        else:
            data["visibility_note"] = "你没有额外夜晚视野。请通过发言与投票寻找真相。"
        return data

    def snapshot(
        self,
        for_player: Optional[str] = None,
        players_public: Optional[List[Dict[str, Any]]] = None,
        host_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        control = self._control_signal(for_player=for_player)
        players = players_public or [
            {"id": pid, "name": self.player_names.get(pid, self.label_of(pid)), "seat": self.seat_of(pid), "label": self.label_of(pid), "connected": True}
            for pid in self.player_order
        ]
        permissions = self._permissions(for_player, host_id)
        return {
            "current_phase": control["current_phase"],
            "control_signal": control,
            "public_announcement": self.public_announcement,
            "players": players,
            "private_info": self.private_info_for(for_player) if for_player else {},
            "permissions": permissions,
            "mission_result_history": self.mission_result_history,
            "team_vote_history": self.team_vote_history,
            "winner": self.winner,
            "error_message": self.error_message,
            "reveal_roles": self._reveal_roles() if self.current_phase == Phase.GAME_OVER else [],
        }

    def set_error(self, message: str) -> None:
        self.error_message = message
        self.public_announcement = f"⚠️ 法官裁定：当前操作无效。{message}"

    def _resolve_team_vote(self) -> None:
        approves = sum(1 for v in self.team_votes.values() if v == "Approve")
        rejects = self.player_count - approves
        approved = approves > self.player_count / 2
        vote_record = {
            "round": self.round,
            "leader": self.display_of(self.leader_id),
            "team": [self.display_of(pid) for pid in self.current_team],
            "approves": approves,
            "rejects": rejects,
            "approved": approved,
            "votes": {self.display_of(pid): vote for pid, vote in self.team_votes.items()},
        }
        self.team_vote_history.append(vote_record)
        self.public_result = vote_record
        if approved:
            self.current_phase = Phase.MISSION_VOTE
            self.mission_votes = {}
            self.active_speaker = None
            self.speaker_queue = []
            team_text = "、".join(self.display_of(pid) or pid for pid in self.current_team)
            self.public_announcement = (
                f"🚩 组队通过。赞成 {approves} 票，反对 {rejects} 票。远征队伍为：{team_text}。"
                "现在进入秘密任务票。此阶段全员禁麦，但文字公屏开放。"
            )
        else:
            self.failed_proposals += 1
            if self.failed_proposals >= 5:
                self.winner = "evil"
                self.current_phase = Phase.GAME_OVER
                self.public_announcement = f"🩸 本轮已经连续 {self.failed_proposals} 次组队失败。圆桌陷入彻底僵局，邪恶阵营直接获胜。"
                self.public_result = {"type": "five_failed_proposals", "winner": self.winner}
                return
            self._advance_leader()
            self.current_team = []
            self.team_votes = {}
            prefix = (
                f"❌ 组队失败。赞成 {approves} 票，反对 {rejects} 票。"
                f"当前为本轮第 {self.failed_proposals} 次炸单。队长顺延为 {self.display_of(self.leader_id)}。"
            )
            if self.round == 1:
                self._enter_team_proposal_open_mic(prefix=prefix)
            else:
                self._enter_pre_team_ordered(prefix=prefix)

    def _resolve_mission_vote(self) -> None:
        fail_count = sum(1 for v in self.mission_votes.values() if v == "Fail")
        threshold = self._mission_fail_threshold()
        mission_failed = fail_count >= threshold
        result = "失败" if mission_failed else "成功"
        success_count = len(self.current_team) - fail_count
        record = {
            "round": self.round,
            "team": [self.display_of(pid) for pid in self.current_team],
            "success_count": success_count,
            "fail_count": fail_count,
            "fail_threshold": threshold,
            "result": result,
        }
        self.mission_result_history.append(record)
        self.public_result = record
        if mission_failed:
            self.score_evil += 1
            score_text = f"正义 {self.score_good}，邪恶 {self.score_evil}"
            if self.score_evil >= 3:
                self.winner = "evil"
                self.current_phase = Phase.GAME_OVER
                self.public_announcement = (
                    f"🩸 第 {self.round} 轮任务结算完成。本次远征出现 {fail_count} 张失败票，任务失败。"
                    f"当前比分：{score_text}。第三次任务失败，王国的防线彻底崩塌。邪恶阵营获胜。"
                )
                return
            self.current_phase = Phase.MISSION_RESULT_DISCUSSION
            self.active_speaker = None
            self.speaker_queue = []
            self.public_announcement = (
                f"⚔️ 第 {self.round} 轮任务结算完成。本次远征出现 {fail_count} 张失败票，任务失败。"
                f"当前比分：{score_text}。现在开放麦克风，所有玩家可以围绕本轮结果复盘；队长稍后进入下一轮。"
            )
        else:
            self.score_good += 1
            score_text = f"正义 {self.score_good}，邪恶 {self.score_evil}"
            if self.score_good >= 3:
                self.current_phase = Phase.ASSASSINATION_DISCUSSION
                self.active_speaker = None
                self.public_announcement = (
                    f"👑 第 {self.round} 轮任务结算完成。本次远征出现 {fail_count} 张失败票，任务成功。"
                    f"当前比分：{score_text}。正义阵营已经完成三次任务，但王国命运尚未落定。现在进入终局刺杀阶段。"
                )
                return
            self.current_phase = Phase.MISSION_RESULT_DISCUSSION
            self.active_speaker = None
            self.speaker_queue = []
            self.public_announcement = (
                f"🛡️ 第 {self.round} 轮任务结算完成。本次远征出现 {fail_count} 张失败票，任务成功。"
                f"当前比分：{score_text}。现在开放麦克风，所有玩家可以围绕本轮结果复盘；队长稍后进入下一轮。"
            )

    def _mission_fail_threshold(self) -> int:
        if self.player_count >= 7 and self.round == 4:
            return 2
        return 1

    def _speaker_order_from_leader(self) -> List[str]:
        start = self.leader_index % self.player_count
        return self.player_order[start:] + self.player_order[:start]

    def _control_signal(self, for_player: Optional[str] = None) -> Dict[str, Any]:
        mic_status = "MUTE_ALL"
        chat_status = "CLOSED"
        vote_status = "CLOSED"
        mission_vote_status = "CLOSED"
        assassination_status = "CLOSED"

        if self.current_phase in {Phase.DISCUSSION_ORDERED, Phase.MISSION_DISCUSSION_ORDERED} and self.active_speaker:
            mic_status = f"MUTE_ALL_EXCEPT_{self.label_of(self.active_speaker)}"
            chat_status = "OPEN_FOR_ALL"
        elif self.current_phase in {
            Phase.DISCUSSION_FREE,
            Phase.TEAM_PROPOSAL,
            Phase.MISSION_RESULT_DISCUSSION,
            Phase.MISSION_DISCUSSION_FREE,
            Phase.ASSASSINATION_DISCUSSION,
            Phase.GAME_OVER,
        }:
            mic_status = "UNMUTE_ALL"
            chat_status = "OPEN_FOR_ALL"
        elif self.current_phase == Phase.TEAM_VOTE:
            vote_status = "OPEN_TEAM_VOTE"
            chat_status = "OPEN_FOR_ALL"
        elif self.current_phase == Phase.MISSION_VOTE:
            mission_vote_status = "OPEN_FOR_TEAM_ONLY"
            chat_status = "OPEN_FOR_ALL"

        if self.current_phase == Phase.ASSASSINATION_DISCUSSION:
            assassination_status = "OPEN_FOR_ASSASSIN_ONLY"

        can_speak = False
        if for_player:
            if self.current_phase in {Phase.DISCUSSION_ORDERED, Phase.MISSION_DISCUSSION_ORDERED}:
                can_speak = for_player == self.active_speaker
            elif self.current_phase in {
                Phase.DISCUSSION_FREE,
                Phase.TEAM_PROPOSAL,
                Phase.MISSION_RESULT_DISCUSSION,
                Phase.MISSION_DISCUSSION_FREE,
                Phase.ASSASSINATION_DISCUSSION,
                Phase.GAME_OVER,
            }:
                can_speak = True

        return {
            "current_phase": self._round_phase_name(self.current_phase),
            "round": self.round,
            "leader": self.label_of(self.leader_id),
            "leader_id": self.leader_id,
            "active_speaker": self.label_of(self.active_speaker),
            "active_speaker_id": self.active_speaker,
            "speaker_queue": [self.label_of(pid) for pid in self.speaker_queue],
            "speaker_queue_ids": self.speaker_queue[:],
            "required_team_size": self.required_team_size,
            "current_team": [self.label_of(pid) for pid in self.current_team],
            "current_team_ids": self.current_team[:],
            "mic_status": mic_status,
            "chat_status": chat_status,
            "vote_status": vote_status,
            "mission_vote_status": mission_vote_status,
            "assassination_status": assassination_status,
            "game_score": {"good": self.score_good, "evil": self.score_evil},
            "failed_proposals": self.failed_proposals,
            "public_result": self.public_result,
            "personal_audio_allowed": can_speak,
        }

    def _permissions(self, player_id: Optional[str], host_id: Optional[str]) -> Dict[str, bool]:
        if not player_id:
            return {}
        role = self.roles.get(player_id)
        return {
            "is_host": player_id == host_id,
            "is_leader": player_id == self.leader_id,
            "can_select_team": self.current_phase == Phase.TEAM_PROPOSAL and player_id == self.leader_id,
            "can_finish_speaker": self.current_phase in {Phase.DISCUSSION_ORDERED, Phase.MISSION_DISCUSSION_ORDERED} and player_id == self.active_speaker,
            "host_can_force_speaker": self.current_phase in {Phase.DISCUSSION_ORDERED, Phase.MISSION_DISCUSSION_ORDERED} and player_id == self.leader_id,
            "can_end_free_discussion": self.current_phase in {Phase.DISCUSSION_FREE, Phase.MISSION_DISCUSSION_FREE} and player_id == self.leader_id,
            "can_continue_after_result": self.current_phase == Phase.MISSION_RESULT_DISCUSSION and player_id == self.leader_id,
            "can_submit_team_vote": self.current_phase == Phase.TEAM_VOTE and player_id not in self.team_votes,
            "can_submit_mission_vote": self.current_phase == Phase.MISSION_VOTE and player_id in self.current_team and player_id not in self.mission_votes,
            "can_submit_fail_mission": self.current_phase == Phase.MISSION_VOTE and player_id in self.current_team,
            "can_submit_assassin_target": self.current_phase == Phase.ASSASSINATION_DISCUSSION and role == Role.ASSASSIN,
            "can_chat": self.can_chat(player_id),
            "can_speak": self._control_signal(for_player=player_id)["personal_audio_allowed"],
            "is_on_team": player_id in self.current_team,
        }

    def _player_private_brief(self, player_id: str) -> Dict[str, Any]:
        return {"id": player_id, "label": self.label_of(player_id), "name": self.player_names.get(player_id, self.label_of(player_id)), "display": self.display_of(player_id)}

    def _reveal_roles(self) -> List[Dict[str, Any]]:
        return [
            {"id": pid, "label": self.label_of(pid), "name": self.player_names.get(pid, self.label_of(pid)), "role": self.roles[pid].value, "side": "good" if self.roles[pid] in GOOD_ROLES else "evil"}
            for pid in self.player_order
        ]


    def to_dict(self) -> Dict[str, Any]:
        """Serialize only durable game state. Runtime sockets/audio state is stored elsewhere."""
        return {
            "player_order": self.player_order,
            "player_names": self.player_names,
            "rng_seed": self.rng_seed,
            "roles": {pid: role.value for pid, role in self.roles.items()},
            "round": self.round,
            "leader_index": self.leader_index,
            "current_team": self.current_team,
            "required_team_size": self.required_team_size,
            "score_good": self.score_good,
            "score_evil": self.score_evil,
            "failed_proposals": self.failed_proposals,
            "current_phase": self.current_phase.value,
            "active_speaker": self.active_speaker,
            "speaker_queue": self.speaker_queue,
            "team_votes": self.team_votes,
            "mission_votes": self.mission_votes,
            "mission_result_history": self.mission_result_history,
            "team_vote_history": self.team_vote_history,
            "public_announcement": self.public_announcement,
            "public_result": self.public_result,
            "winner": self.winner,
            "error_message": self.error_message,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AvalonGame":
        game = cls(
            player_order=list(data.get("player_order") or []),
            player_names=dict(data.get("player_names") or {}),
            rng_seed=data.get("rng_seed"),
        )
        game.roles = {pid: Role(role) for pid, role in (data.get("roles") or {}).items()}
        game.round = int(data.get("round", 1))
        game.leader_index = int(data.get("leader_index", 0))
        game.current_team = list(data.get("current_team") or [])
        game.required_team_size = int(data.get("required_team_size") or CONFIG[game.player_count]["mission_sizes"][max(0, game.round - 1)])
        game.score_good = int(data.get("score_good", 0))
        game.score_evil = int(data.get("score_evil", 0))
        game.failed_proposals = int(data.get("failed_proposals", 0))
        game.current_phase = Phase(data.get("current_phase", Phase.LOBBY.value))
        game.active_speaker = data.get("active_speaker")
        game.speaker_queue = list(data.get("speaker_queue") or [])
        game.team_votes = dict(data.get("team_votes") or {})
        game.mission_votes = dict(data.get("mission_votes") or {})
        game.mission_result_history = list(data.get("mission_result_history") or [])
        game.team_vote_history = list(data.get("team_vote_history") or [])
        game.public_announcement = data.get("public_announcement") or "等待玩家加入圆桌。"
        game.public_result = data.get("public_result")
        game.winner = data.get("winner")
        game.error_message = data.get("error_message")
        return game

    def _require_phase(self, expected: Phase) -> None:
        if self.current_phase != expected:
            raise ValueError(f"当前阶段是 {self.current_phase.value}，不能执行该操作。")

    def _clear_error(self) -> None:
        self.error_message = None
