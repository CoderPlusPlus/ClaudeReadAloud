from claudevoice.text import CODE_NOTE, TABLE_NOTE, to_speech


def test_formatting_marks_are_not_spoken():
    assert to_speech("**Bold**, *italic* and ~~gone~~ text") == "Bold, italic and gone text."


def test_code_blocks_become_one_note():
    spoken = to_speech("Before.\n\n```python\nprint('x')\n```\n\n    indented code\n\nAfter.")
    assert spoken.splitlines() == ["Before.", CODE_NOTE, "After."]


def test_tables_become_a_note_and_their_cells_are_skipped():
    spoken = to_speech("| Voice | Grade |\n|---|---|\n| Heart | A |\n\nDone.")
    assert spoken.splitlines() == [TABLE_NOTE, "Done."]


def test_each_block_ends_as_a_sentence():
    spoken = to_speech("# Heading\n\n- first item\n- second item!\n\nQuestion?")
    assert spoken.splitlines() == ["Heading.", "first item.", "second item!", "Question?"]


def test_links_read_as_their_text():
    assert to_speech("Open [the guide](https://example.com/guide) now.") == "Open the guide now."


def test_bare_urls_read_as_a_link():
    assert to_speech("Go to https://example.com/a/b?c=1 for more.") == "Go to a link for more."


def test_paths_read_as_their_last_part():
    spoken = to_speech(r"Edit `C:\Users\me\project\main.py`, then src/utils/foo.ts and ~/.claude/settings.json.")
    assert spoken == "Edit main.py, then foo.ts and settings.json."


def test_short_slashes_are_left_alone():
    assert to_speech("Use and/or 1/2 here.") == "Use and/or 1/2 here."


def test_dates_and_single_letter_chains_are_not_paths():
    assert to_speech("Due on 10/17/2026 at noon.") == "Due on 10/17/2026 at noon."
    assert to_speech("Pick a/b/c or 1/2/3.") == "Pick a/b/c or 1/2/3."
    assert to_speech("Open src/lib/a/b.py now.") == "Open b.py now."


def test_a_file_with_one_folder_reads_as_the_file():
    assert to_speech("See hooks/register.tsx:42 for it.") == "See register.tsx:42 for it."


def test_inline_code_keeps_its_words_and_spacing():
    assert to_speech("Run `kokoro-onnx` on the CPU.") == "Run kokoro-onnx on the CPU."


def test_line_breaks_inside_a_paragraph_join_with_a_space():
    assert to_speech("one\ntwo") == "one two."


def test_arrows_and_symbols_are_spoken_as_words():
    assert to_speech("A → B & C") == "A to B and C."


def test_html_is_skipped():
    assert to_speech("<div>x</div>\n\nText <b>here</b>.") == "Text here."


def test_images_read_as_their_description():
    assert to_speech("![diagram](x.png) shows it") == "diagram shows it."
    assert to_speech("![](x.png)\n\nText.") == "Text."


def test_empty_and_code_only_replies():
    assert to_speech("") == ""
    assert to_speech("```\ncode\n```") == CODE_NOTE


def test_a_link_at_the_end_of_a_sentence_keeps_the_sentence_break():
    assert to_speech("Visit https://x.com. Then go.") == "Visit a link. Then go."
    assert to_speech("See (https://x.com/a?b=1), then go.") == "See (a link), then go."


def test_symbols_are_spoken_in_text_but_not_in_code():
    assert to_speech("Salt & pepper") == "Salt and pepper."
    assert to_speech("Use `a && b` here") == "Use a && b here."
