from gnosis.core.redact import redact


def test_masks_keys_cards_and_passwords():
    text, n = redact("key sk-abcdefghijklmnopqrstuv card 4111 1111 1111 1111 password: hunter2")
    assert "sk-abc" not in text and "4111" not in text and "hunter2" not in text
    assert n == 3


def test_leaves_normal_text_alone():
    assert redact("Open Spotify and play Madhuvarame") == ("Open Spotify and play Madhuvarame", 0)
