# ClaudeVoice

Reads a short spoken version of Claude's replies aloud in the Claude desktop app as they arrive, using the free Kokoro voice model on this PC. Nothing is sent over the internet.

There are two parts:

- **Speaker** (`claudevoice/`): a small Python program that runs in the background. It turns text into speech and plays it. It answers only on `127.0.0.1` (this PC), on the port set in `config.json`.
- **Add-on** (`addon/`): a row above the prompt in each session with a **Voice: on** / **Voice: off** button, a voice picker, a **Repeat** button, a **Pause** button and a **Skip** button. Repeat clears the session's queue, cuts off any other session's speech and announcements, and says the latest block's saved summary again (or has Haiku make one if none is saved); it works with voice on or off. While the session is summarizing, starting or speaking, Repeat becomes **Stop** (it also shows while paused), which silences the session and clears its queue without changing the voice switch. Pause sets the session's speech aside, and Resume carries on from the beginning of the sentence it was in, then through the rest of the session's queue. Pausing affects only that session: other sessions can still speak while it is paused, they never cut off its paused speech, and a paused session does not announce itself. Resume cuts off another session's speech the way new speech does; Stop, Repeat and turning voice off end the pause, and Skip moves to the next block and stays paused. Skip cuts off the block being spoken (or drops it if it is still being summarized) and moves on to the next one; it does nothing on the last block in the queue. Each session has its own switch and its own voice.

Claude often writes a little, runs some tools, then writes some more, all in one turn. Each of those pieces of writing is a block. With voice on, each block joins that session's queue as soon as Claude finishes writing it, so you hear the first block while Claude is still working. Claude's thinking is read too, as its own block ahead of the reply from the same step, including a step that only runs tools; a step with no thinking and no text adds nothing. The add-on asks Haiku for a short spoken version of each block (plain words, no code or symbols); thinking is retold as thinking out loud. A block of a sentence or two stays about that long; a longer one is cut to about a third, and never more than 120 words. Several summaries can be made at once, but blocks are spoken one after another in the order they arrived, and a newer block never cancels an older one. While a queue is going the row shows **Message n of m**: m is how many blocks are in it, n is the one being summarized or spoken. Each block counts as soon as it arrives. The label goes away when the last one is done, and the next block starts again at **Message 1 of 1**. If Haiku cannot make a summary, a message says why and the full block is read instead. The row shows **Summarizing…** while Haiku works and **Starting voice…** while the speaker starts. If the speaker is not running, the add-on starts it while Haiku works, and starts it again if it goes down when a message is about to be sent. Each reply is drawn with a colored stripe down its left side. Turning voice off stops that session's speech and clears its queue.

The picker lists the voices best grade first, with labels like "Bella - Female (A-)". Each session starts on the `voice` from `config.json`, and picking another changes only that session.

Only one thing is ever heard at a time. A session's block cuts off other sessions' speech, but waits for its own earlier blocks to finish. If a session is not on screen, its blocks still join the queue and are summarized while Claude works, but they are held and the row shows **Will speak when you open this session**. When Claude finishes the turn, if any held blocks have not been heard, it says "<name> has finished and would like to speak." (waiting its turn behind anything already playing). If another session's block cuts the announcement off, it is sent again from the start, so you can hear part of it and then all of it. When you switch to that session, up to three held blocks are spoken in order; more than three are combined into one catch-up, in at most 200 words, that leaves out what later blocks made out of date and asks any still-open questions once at the end. If the catch-up cannot be made, a message says why and each block's own spoken version is played one after another. If you switch to it while Claude is still working, the blocks play as they arrive, just as they do in a session on screen.

The speaker normally keeps running after the app closes, so the next reply starts talking right away. If the app does not allow that, the speaker closes with the app and the next reply starts it again. Only one copy runs at a time.

## Setup

```bash
py -3.11 -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt
```

Download these two files from the kokoro-onnx `model-files-v1.0` release (https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0) into `models/`:

- `kokoro-v1.0.onnx` (310 MB)
- `voices-v1.0.bin` (27 MB)

Install the add-on, giving the full path of this folder:

```bash
claude plugin marketplace add C:/path/to/ClaudeVoice
claude plugin install read-aloud@ray-voice --scope user
```

The installed add-on is a copy of `addon/`. It finds the speaker program and `config.json` in the folder you added with `marketplace add`, so keep that folder where it is.

After you change anything in `addon/`, raise `version` in `addon/.claude-plugin/plugin.json`, then update the installed copy:

```bash
claude plugin marketplace update ray-voice
claude plugin update read-aloud@ray-voice
```

There is no need to restart Claude: the new version loads while Claude is running. The label at the right end of the row (for example "read-aloud v0.1.9") shows which version is loaded.

## Settings

`config.json`:

| Setting | Meaning |
|---|---|
| `voice` | The voice each session's picker starts on. Names starting `af_`/`am_` are American women/men, and `bf_`/`bm_` are British. The default is `af_heart`. Changing the picker in a session does not change this file. |
| `speed` | 0.5 to 2.0. 1.0 is normal speed. |
| `port` | The local port the speaker listens on. |

The speaker reads `speed` and `port` when it starts. To change them, stop the speaker first, then edit `config.json`; the next reply starts it again with the new settings. If you edit the port first, the stop command goes to the new port and the old speaker keeps running.

The `voice` setting is read by the add-on, not the speaker. Each session reads it when the session starts, and the add-on tells the speaker which voice to use on every request. To change it, edit `config.json` and start new sessions; sessions already open keep the voice they started with, and the speaker does not need to be stopped.

Kokoro's own grades for each voice are listed at https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md.

## Commands

```bash
.venv/Scripts/python.exe -m claudevoice start
```

```bash
.venv/Scripts/python.exe -m claudevoice stop
```

`start` does nothing if the speaker is already running. The speaker writes its log to `logs/speaker.log`.

## Spoken log

The speaker keeps a record of everything it speaks, so you can compare what you heard with the session's transcript (the session's `.jsonl` file). There is one file per day, `logs/spoken/YYYY-MM-DD.jsonl`, named by the local date. Each time something ends (finished, stopped, failed, or had nothing to say), one line is added. Each line is a JSON object with:

| Field | Meaning |
|---|---|
| `start` | When the speaker received it (local time with its offset from UTC). |
| `played` | When the job's turn to play came, or `null` if it never got one (for example, stopped while waiting). The sound may not have begun: a job that fails before any audio is made or the audio device opens still has a time here. |
| `end` | When it ended. |
| `job`, `result`, `error` | The job number, how it ended (`finished`, `stopped`, `error` or `nothing`), and the error message when there was one. |
| `owner`, `voice` | The session that asked for it and the voice used. |
| `text` | The text the speaker was asked to say, after it removed formatting such as markdown. If `played` is `null`, none of it was played. |
| `record` | What the add-on sent about it, or `null` if nothing was sent. A record over 8 MB is kept as a short note saying it was too large; the speech still plays. |

The add-on's `record` holds `session` (the session's id), `sessionName`, and `kind`: `thinking`, `reply`, `announcement`, `catch-up` or `repeat`. For thinking and reply blocks it also holds `turnId`, `step` (the model step within the turn, from 0), `toolUseIds` (the ids of the tool calls Claude made in that same step, which match the `id` of the `tool_use` blocks in the transcript), and `original` (the block's text before Haiku). A catch-up's `original` is a list with those same details for every block it was made from, and a repeat's `original` is the text that was repeated. `summary` says how the spoken text was made (announcements have none): `haiku`, `saved` (a summary made earlier was reused), `full-text` (Haiku failed, so the whole block was read; `reason` says why), `runaway` (Haiku's version was far longer than the block, so the block was read instead) or, for a catch-up, `separate` (the catch-up could not be made, so each block's own spoken version was played back to back; `reason` says why).

The first time a line is added each day (counted again each time the speaker starts), files whose date is more than 7 days before that day are removed. Other files in the folder are left alone. If the log cannot be written or cleaned up, speech carries on and the problem is noted in `logs/speaker.log`.

## Tests

```bash
.venv/Scripts/python.exe -m pytest
```

```bash
claude plugin test addon
```

## License

ClaudeVoice's own code is released under the MIT License; see `LICENSE`.

## Credits and licenses

ClaudeVoice does not include any of the projects below. The voice model files are downloaded separately during setup, and the libraries are installed from PyPI, each under its own license.

| Project | Used for | License |
|---|---|---|
| [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad | The voice model and voices | Apache 2.0 |
| [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) | Runs the Kokoro model on this PC | MIT |
| [espeak-ng](https://github.com/espeak-ng/espeak-ng) (installed through espeakng-loader) | Turns words into the sounds Kokoro speaks | GPL 3.0 |
| [phonemizer](https://github.com/bootphon/phonemizer) | Used by kokoro-onnx for pronunciation | GPL 3.0 or later |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | Runs the model on the processor | MIT |
| [sounddevice](https://github.com/spatialaudio/python-sounddevice) | Plays the audio | MIT |
| [markdown-it-py](https://github.com/executablebooks/markdown-it-py) | Reads replies' formatting so it is not spoken | MIT |
| [NumPy](https://numpy.org) | Audio data | BSD 3-Clause |

The full list of libraries and versions is in `requirements.txt`.
