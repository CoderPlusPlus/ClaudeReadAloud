import numpy as np
import pytest

from claudevoice.engine import PARAGRAPH_PAUSE, SENTENCE_PAUSE, pieces
from tests.fakes import FakeSynthesizer, make_speaker


@pytest.fixture
def close_later():
    speakers = []
    yield speakers.append
    for speaker in speakers:
        speaker.close()


def test_pieces_split_sentences_and_pause_after_each():
    assert pieces("One. Two!\nThree?") == [("One.", SENTENCE_PAUSE), ("Two!", PARAGRAPH_PAUSE), ("Three?", 0.0)]
    assert pieces("") == []
    assert pieces("\n  \n") == []


def test_abbreviations_do_not_end_a_sentence():
    spoken = 'I am e.g. fine! Dr. Lee said "Mr. Kim" met J. Smith on v1. Then left.'
    assert [piece for piece, _ in pieces(spoken)] == ["I am e.g. fine!", 'Dr. Lee said "Mr. Kim" met J. Smith on v1. Then left.']
    assert [piece for piece, _ in pieces("It ended. Then more.")] == ["It ended.", "Then more."]


def test_a_reply_plays_to_the_end(close_later):
    speaker, players, synthesizer = make_speaker()
    close_later(speaker)
    job = speaker.speak("First sentence. Second sentence.")
    assert speaker.wait(job) == {"job": job, "result": "finished"}
    assert synthesizer.spoken == ["First sentence.", "Second sentence."]
    player = players.made[0]
    assert player.is_finished and player.is_closed
    assert len(player.audio) == 4


def test_stop_cuts_off_speech(close_later):
    speaker, players, _ = make_speaker(holds=True)
    close_later(speaker)
    job = speaker.speak("Hello there.")
    assert players.playing()
    assert speaker.is_speaking()
    speaker.stop()
    assert speaker.wait(job) == {"job": job, "result": "stopped"}
    assert players.made[0].is_closed
    assert not speaker.is_speaking()


def test_a_new_reply_replaces_the_one_playing(close_later):
    speaker, players, _ = make_speaker(holds=True)
    close_later(speaker)
    first = speaker.speak("First.")
    assert players.playing()
    second = speaker.speak("Second.")
    assert speaker.wait(first)["result"] == "stopped"
    assert players.made[0].is_closed
    speaker.stop()
    assert speaker.wait(second)["result"] == "stopped"


def test_two_quick_requests_both_get_an_answer(close_later):
    speaker, _, _ = make_speaker(holds=True)
    close_later(speaker)
    jobs = [speaker.speak("Quick.") for _ in range(5)]
    speaker.stop()
    assert [speaker.wait(job)["result"] for job in jobs] == ["stopped"] * 5


def test_nothing_to_say(close_later):
    speaker, players, _ = make_speaker()
    close_later(speaker)
    job = speaker.speak("")
    assert speaker.wait(job)["result"] == "nothing"
    assert players.made == []


def test_empty_text_does_not_cut_off_what_is_playing(close_later):
    speaker, players, _ = make_speaker(holds=True)
    close_later(speaker)
    playing = speaker.speak("Still talking.")
    assert players.playing()
    empty = speaker.speak("")
    assert speaker.wait(empty)["result"] == "nothing"
    assert speaker.is_speaking()
    speaker.stop()
    assert speaker.wait(playing)["result"] == "stopped"


def test_a_piece_with_no_sounds_is_skipped(close_later):
    speaker, _, synthesizer = make_speaker(synthesizer=FakeSynthesizer(fail_on="..."))
    close_later(speaker)
    job = speaker.speak("Hi. ...\n\nBye.")
    assert speaker.wait(job)["result"] == "finished"
    assert synthesizer.spoken == ["Hi.", "Bye."]


def test_a_missing_sound_device_is_reported(close_later):
    from claudevoice.config import Config
    from claudevoice.engine import Speaker

    def no_device(_rate):
        raise OSError("no output device")

    speaker = Speaker(FakeSynthesizer(), Config(), no_device)
    close_later(speaker)
    job = speaker.speak("Hello.")
    assert speaker.wait(job) == {"job": job, "result": "error", "error": "no output device"}


def test_unknown_jobs_say_so(close_later):
    speaker, _, _ = make_speaker()
    close_later(speaker)
    assert speaker.wait(999)["result"] == "unknown"


def test_old_jobs_are_forgotten(close_later):
    speaker, _, _ = make_speaker()
    close_later(speaker)
    jobs = [speaker.speak("Hi.") for _ in range(20)]
    assert speaker.wait(jobs[0])["result"] == "unknown"
    assert speaker.wait(jobs[-1])["result"] == "finished"


def test_simultaneous_requests_leave_nothing_playing_after_stop(close_later):
    from concurrent.futures import ThreadPoolExecutor

    speaker, players, _ = make_speaker(holds=True)
    close_later(speaker)
    speaker.speak("First.")
    assert players.playing()
    with ThreadPoolExecutor(8) as pool:
        jobs = list(pool.map(speaker.speak, ["Again."] * 8))
    speaker.stop()
    assert [speaker.wait(job)["result"] for job in jobs] == ["stopped"] * 8
    assert all(player.is_closed for player in players.made)


def test_each_request_can_pick_its_voice_and_accent(close_later):
    speaker, _, synthesizer = make_speaker()
    close_later(speaker)
    assert speaker.wait(speaker.speak("Hi.", voice="bm_george"))["result"] == "finished"
    assert speaker.wait(speaker.speak("Hi."))["result"] == "finished"
    assert synthesizer.voices == [("bm_george", "en-gb"), ("af_heart", "en-us")]


def test_unknown_voices_are_refused():
    from claudevoice.config import Config
    from claudevoice.engine import Speaker

    speaker = Speaker(FakeSynthesizer(), Config(), voices=["af_heart", "bm_george"])
    try:
        assert speaker.knows_voice("bm_george")
        assert not speaker.knows_voice("am_nobody")
        assert not speaker.knows_voice("jf_alpha")
        with pytest.raises(ValueError):
            speaker.speak("Hi.", voice="am_nobody")
    finally:
        speaker.close()


def test_stop_with_an_owner_leaves_other_owners_alone(close_later):
    speaker, players, _ = make_speaker(holds=True)
    close_later(speaker)
    first = speaker.speak("One.", owner="a")
    assert players.playing()
    queued = speaker.speak("Two.", owner="b", queue=True)
    speaker.stop("b")
    assert speaker.wait(queued)["result"] == "stopped"
    assert speaker.is_speaking()
    speaker.stop("a")
    assert speaker.wait(first)["result"] == "stopped"
    assert not speaker.is_speaking()


def test_queued_speech_waits_for_what_is_playing(close_later):
    speaker, players, synthesizer = make_speaker(holds=True)
    close_later(speaker)
    first = speaker.speak("First.", owner="a")
    assert players.playing()
    queued = speaker.speak("Second.", owner="b", queue=True)
    assert synthesizer.spoken == ["First."]
    players.made[0].close()
    assert players.playing(2)
    assert speaker.wait(first)["result"] == "finished"
    assert synthesizer.spoken == ["First.", "Second."]
    speaker.stop()
    assert speaker.wait(queued)["result"] == "stopped"


def test_speech_that_is_not_queued_cuts_off_queued_speech_too(close_later):
    speaker, players, _ = make_speaker(holds=True)
    close_later(speaker)
    first = speaker.speak("First.", owner="a")
    assert players.playing()
    queued = speaker.speak("Second.", owner="b", queue=True)
    latest = speaker.speak("Third.", owner="c")
    assert speaker.wait(first)["result"] == "stopped"
    assert speaker.wait(queued)["result"] == "stopped"
    assert players.playing(2)
    speaker.stop()
    assert speaker.wait(latest)["result"] == "stopped"



def test_stopping_a_waiting_speech_does_not_let_the_one_behind_it_start_early(close_later):
    speaker, players, synthesizer = make_speaker(holds=True)
    close_later(speaker)
    first = speaker.speak("First.", owner="a")
    assert players.playing()
    second = speaker.speak("Second.", owner="b", queue=True)
    third = speaker.speak("Third.", owner="c", queue=True)
    speaker.stop("b")
    assert speaker.wait(second)["result"] == "stopped"
    assert len(players.made) == 1
    assert synthesizer.spoken == ["First."]
    players.made[0].close()
    assert speaker.wait(first)["result"] == "finished"
    assert players.playing(2)
    assert synthesizer.spoken == ["First.", "Third."]
    speaker.stop()
    assert speaker.wait(third)["result"] == "stopped"


def test_speech_that_is_only_waiting_does_not_count_as_speaking(close_later):
    speaker, players, _ = make_speaker(holds=True)
    close_later(speaker)
    speaker.speak("First.", owner="a")
    assert players.playing()
    speaker.speak("Second.", owner="b", queue=True)
    assert speaker.is_speaking()
    waiting_only = speaker._playing[1:]
    assert [p.owner for p in waiting_only] == ["b"]
    speaker._playing, everything = waiting_only, speaker._playing
    assert not speaker.is_speaking()
    speaker._playing = everything
    speaker.stop()


def test_after_own_cuts_off_other_owners_but_waits_for_its_own(close_later):
    speaker, players, synthesizer = make_speaker(holds=True)
    close_later(speaker)
    other = speaker.speak("Other.", owner="b")
    assert players.playing()
    own = speaker.speak("Own first.", owner="a", after_own=True)
    assert speaker.wait(other)["result"] == "stopped"
    assert players.playing(2)
    later = speaker.speak("Own second.", owner="a", after_own=True)
    assert synthesizer.spoken == ["Other.", "Own first."]
    players.made[1].close()
    assert speaker.wait(own)["result"] == "finished"
    assert players.playing(3)
    assert synthesizer.spoken == ["Other.", "Own first.", "Own second."]
    speaker.stop()
    assert speaker.wait(later)["result"] == "stopped"


def test_after_own_needs_an_owner_and_no_queue():
    from claudevoice.config import Config
    from claudevoice.engine import Speaker

    speaker = Speaker(FakeSynthesizer(), Config())
    try:
        with pytest.raises(ValueError):
            speaker.speak("Hi.", after_own=True)
        with pytest.raises(ValueError):
            speaker.speak("Hi.", owner="a", queue=True, after_own=True)
    finally:
        speaker.close()


def test_stop_with_a_job_stops_only_that_job_and_the_next_one_plays(close_later):
    speaker, players, synthesizer = make_speaker(holds=True)
    close_later(speaker)
    first = speaker.speak("First.", owner="a")
    assert players.playing()
    second = speaker.speak("Second.", owner="a", after_own=True)
    speaker.stop(job=first)
    assert speaker.wait(first)["result"] == "stopped"
    assert players.playing(2)
    assert synthesizer.spoken == ["First.", "Second."]
    speaker.stop()
    assert speaker.wait(second)["result"] == "stopped"


def test_tidy_keeps_a_tail_after_the_last_sound_and_drops_the_rest():
    from claudevoice.engine import LEAD_KEPT, SAMPLE_RATE, TAIL_KEPT, tidy

    silence = np.zeros(SAMPLE_RATE, dtype=np.float32)
    sound = np.full(SAMPLE_RATE // 2, 0.5, dtype=np.float32)
    fade = np.full(SAMPLE_RATE // 10, 0.02, dtype=np.float32)
    audio = np.concatenate([silence, sound, fade, silence])
    tidied = tidy(audio)
    expected = int(LEAD_KEPT * SAMPLE_RATE) + len(sound) + len(fade) + int(TAIL_KEPT * SAMPLE_RATE)
    assert len(tidied) == expected
    assert tidied[int(LEAD_KEPT * SAMPLE_RATE)] == 0.5
    assert len(tidy(np.zeros(100, dtype=np.float32))) == 0
    assert len(tidy(np.zeros(0, dtype=np.float32))) == 0


def test_speech_asks_for_untrimmed_audio_and_ends_with_silence(close_later):
    speaker, players, synthesizer = make_speaker()
    close_later(speaker)
    trims = []
    original = synthesizer.create_stream

    def recording(text, voice, speed, lang, trim=True):
        trims.append(trim)
        return original(text, voice, speed, lang, trim)

    synthesizer.create_stream = recording
    assert speaker.wait(speaker.speak("Hello."))["result"] == "finished"
    assert trims == [False]
    assert not players.made[0].audio[-1].any()

