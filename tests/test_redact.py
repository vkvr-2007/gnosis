from gnosis.core.redact import redact


def test_masks_keys_cards_and_passwords():
    text, n = redact("key sk-abcdefghijklmnopqrstuv card 4111 1111 1111 1111 password: hunter2")
    assert "sk-abc" not in text and "4111" not in text and "hunter2" not in text
    assert n == 3


def test_leaves_normal_text_alone():
    assert redact("Open Spotify and play Madhuvarame") == ("Open Spotify and play Madhuvarame", 0)


def test_masks_cut_off_tokens_and_named_secrets():
    text, n = redact("supabase - eyJhbGciOiJIUzI1NiIsInR5cCI6 - Notepad")
    assert "eyJhbGci" not in text and n == 1
    text, n = redact("SUPABASE_ANON_KEY=abcd1234efgh5678 and sb_secret_abcdefghijklmnop")
    assert "abcd1234" not in text and "sb_secret_abc" not in text and n == 2
    assert redact("api_key: sk-abcdefghijklmnopqrstuv")[1] == 1  # Counted once
