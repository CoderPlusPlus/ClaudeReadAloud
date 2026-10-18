# ClaudeVoice

Reads a short spoken version of Claude's replies aloud in the Claude desktop app as they arrive, using the free Kokoro voice model on this PC. Nothing is sent over the internet.

There are two parts:

- **Speaker** (`claudevoice/`): a small Python program that runs in the background. It turns text into speech and plays it. It answers only on `127.0.0.1` (this PC), on the port set in `config.json`.
- **Add-on** (`addon/`): a row above the prompt in each session with a **Voice: on** / **Voice: off** button, a voice picker, a **Repeat** button and a **Skip** button. Repeat clears the session's queue and says the latest block's saved summary again (or has Haiku make one if none is saved); it works with voice on or off. While the session is summarizing, starting or speaking, Repeat becomes **Stop**, which silences the session and clears its queue without changing the voice switch. Skip cuts off the block being spoken (or drops it if it is still being summarized) and moves on to the next one; it does nothing on the last block in the queue. Each session has its own switch and its own voice.

Claude often writes a little, runs some tools, then writes some more, all in one turn. Each of those pieces of writing is a block. With voice on, each block joins that session's queue as soon as Claude finishes writing it, so you hear the first block while Claude is still working; a piece that only runs tools adds nothing. The add-on asks Haiku for a short spoken version of each block (plain words, no code or symbols). A block of a sentence or two stays about that long; a longer one is cut to about a third, and never more than 120 words. Several summaries can be made at once, but blocks are spoken one after another in the order they arrived, and a newer block never cancels an older one. While a queue is going the row shows **Message n of m**: m is how many blocks are in it, n is the one being summarized or spoken. Each block counts as soon as it arrives. The label goes away when the last one is done, and the next block starts again at **Message 1 of 1**. If Haiku cannot make a summary, a message says why and the full block is read instead. The row shows **Summarizing…** while Haiku works and **Starting voice…** while the speaker starts. If the speaker is not running, the add-on starts it while Haiku works. Turning voice off stops that session's speech and clears its queue.

The picker lists the voices best grade first, with labels like "Bella - Female (A-)". Each session starts on the `voice` from `config.json`, and picking another changes only that session.

Only one thing is ever heard at a time. A session's block cuts off other sessions' speech, but waits for its own earlier blocks to finish. If a session is not on screen, its blocks still join the queue and are summarized while Claude works, but they are held and the row shows **Will speak when you open this session**. When Claude finishes the turn, if any held blocks have not been heard, it says "<name> has finished and would like to speak." once (waiting its turn behind anything already playing). When you switch to that session, the held blocks are spoken in order. If you switch to it while Claude is still working, the blocks play as they arrive, just as they do in a session on screen.

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

## Tests

```bash
.venv/Scripts/python.exe -m pytest
```

```bash
claude plugin test addon
```
