import pytest

from avalon_engine import AvalonGame, Role, Phase


def make_game(n=5, seed=1):
    players = [f"p{i}" for i in range(1, n + 1)]
    names = {pid: f"User{i}" for i, pid in enumerate(players, start=1)}
    game = AvalonGame(player_order=players, player_names=names, rng_seed=seed)
    game.start()
    return game, players


def advance_pre_team_discussion_to_selection(game):
    if game.current_phase == Phase.TEAM_PROPOSAL:
        return
    order = game._speaker_order_from_leader()
    for pid in order:
        assert game.active_speaker == pid
        game.speaker_finished(pid)
    assert game.current_phase == Phase.DISCUSSION_FREE
    game.finish_free_discussion()
    assert game.current_phase == Phase.TEAM_PROPOSAL


def approve_current_team(game, players):
    for pid in players:
        game.submit_team_vote(pid, "Approve")


def test_configs_cover_5_to_10():
    for n in range(5, 11):
        game, players = make_game(n)
        assert len(game.roles) == n
        assert game.current_phase == Phase.TEAM_PROPOSAL
        assert game.required_team_size in {2, 3, 4, 5}
        assert game.snapshot(players[0])["control_signal"]["chat_status"] == "OPEN_FOR_ALL"


def test_first_round_begins_with_public_mic_team_selection():
    game, players = make_game(5)
    leader = game.leader_id
    assert game.current_phase == Phase.TEAM_PROPOSAL
    snap = game.snapshot(leader)["control_signal"]
    assert snap["mic_status"] == "UNMUTE_ALL"
    assert snap["chat_status"] == "OPEN_FOR_ALL"


def test_leader_select_team_enters_team_vote_without_extra_mic_discussion():
    game, players = make_game(5)
    advance_pre_team_discussion_to_selection(game)
    leader = game.leader_id
    game.select_team(leader, players[:2])
    assert game.current_phase == Phase.TEAM_VOTE
    snap = game.snapshot(leader)["control_signal"]
    assert snap["mic_status"] == "MUTE_ALL"
    assert snap["vote_status"] == "OPEN_TEAM_VOTE"


def test_team_vote_reject_advances_leader_and_restarts_pre_team_discussion():
    game, players = make_game(5)
    old_leader = game.leader_id
    advance_pre_team_discussion_to_selection(game)
    game.select_team(old_leader, players[:2])
    for pid in players[:3]:
        game.submit_team_vote(pid, "Reject")
    for pid in players[3:]:
        game.submit_team_vote(pid, "Approve")
    assert game.current_phase == Phase.TEAM_PROPOSAL
    assert game.failed_proposals == 1
    assert game.leader_id != old_leader
    assert game.active_speaker is None


def test_five_failed_proposals_evil_wins():
    game, players = make_game(5)
    for _ in range(5):
        leader = game.leader_id
        advance_pre_team_discussion_to_selection(game)
        game.select_team(leader, players[: game.required_team_size])
        for pid in players:
            game.submit_team_vote(pid, "Reject")
    assert game.current_phase == Phase.GAME_OVER
    assert game.winner == "evil"


def test_round_4_requires_two_fails_for_7_plus():
    game, players = make_game(7)
    game.roles = {pid: Role.LOYAL for pid in players}
    game.roles[players[0]] = Role.MERLIN
    game.roles[players[1]] = Role.PERCIVAL
    game.roles[players[2]] = Role.MORGANA
    game.roles[players[3]] = Role.ASSASSIN
    game.roles[players[4]] = Role.OBERON
    game.roles[players[5]] = Role.LOYAL
    game.roles[players[6]] = Role.LOYAL
    game.round = 4
    game.required_team_size = 4
    game.current_phase = Phase.MISSION_VOTE
    game.current_team = [players[0], players[2], players[5], players[6]]
    game.submit_mission_vote(players[0], "Success")
    game.submit_mission_vote(players[2], "Fail")
    game.submit_mission_vote(players[5], "Success")
    game.submit_mission_vote(players[6], "Success")
    assert game.score_good == 1
    assert game.score_evil == 0
    assert game.current_phase == Phase.MISSION_RESULT_DISCUSSION


def test_team_vote_approved_enters_mission_vote_directly():
    game, players = make_game(5)
    advance_pre_team_discussion_to_selection(game)
    leader = game.leader_id
    game.select_team(leader, players[:2])
    approve_current_team(game, players)
    assert game.current_phase == Phase.MISSION_VOTE
    snap = game.snapshot(players[0])["control_signal"]
    assert snap["mic_status"] == "MUTE_ALL"
    assert snap["mission_vote_status"] == "OPEN_FOR_TEAM_ONLY"


def test_mission_result_opens_microphone_then_host_can_continue():
    game, players = make_game(5)
    advance_pre_team_discussion_to_selection(game)
    leader = game.leader_id
    game.select_team(leader, players[:2])
    approve_current_team(game, players)
    game.submit_mission_vote(players[0], "Success")
    game.submit_mission_vote(players[1], "Success")
    assert game.current_phase == Phase.MISSION_RESULT_DISCUSSION
    assert game.snapshot(players[0])["control_signal"]["mic_status"] == "UNMUTE_ALL"
    game.continue_after_mission_result()
    assert game.round == 2
    assert game.current_phase == Phase.DISCUSSION_ORDERED


def test_all_team_players_can_submit_fail_in_experience_mode():
    game, players = make_game(5)
    game.roles[players[0]] = Role.MERLIN
    game.current_phase = Phase.MISSION_VOTE
    game.current_team = [players[0], players[1]]
    game.submit_mission_vote(players[0], "Fail")
    assert game.mission_votes[players[0]] == "Fail"


def test_assassin_killing_merlin_makes_evil_win():
    game, players = make_game(5)
    game.roles = {
        players[0]: Role.MERLIN,
        players[1]: Role.PERCIVAL,
        players[2]: Role.LOYAL,
        players[3]: Role.MORGANA,
        players[4]: Role.ASSASSIN,
    }
    game.score_good = 3
    game.current_phase = Phase.ASSASSINATION_DISCUSSION
    game.submit_assassin_target(players[4], players[0])
    assert game.current_phase == Phase.GAME_OVER
    assert game.winner == "evil"


def test_round_leader_controls_discussion_and_next_round():
    game, players = make_game(5)
    leader = game.leader_id
    assert game.snapshot(leader, host_id=players[0])["permissions"]["can_select_team"] is True
    game.select_team(leader, players[:2])
    approve_current_team(game, players)
    game.submit_mission_vote(players[0], "Success")
    game.submit_mission_vote(players[1], "Success")
    assert game.snapshot(leader, host_id=players[0])["permissions"]["can_continue_after_result"] is True
