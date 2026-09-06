from app.services.secret_redaction import redact_secrets


def test_redacts_a_single_occurrence():
    text = "could not reach http://x: 401 Unauthorized, header was Bearer abc123secret"
    result = redact_secrets(text, ["abc123secret"])
    assert "abc123secret" not in result
    assert "***REDACTED***" in result


def test_redacts_multiple_occurrences_of_the_same_secret():
    text = "abc123secret failed; retry with abc123secret again"
    result = redact_secrets(text, ["abc123secret"])
    assert "abc123secret" not in result


def test_redacts_multiple_distinct_secrets():
    text = "token=tok-111 key=key-222"
    result = redact_secrets(text, ["tok-111", "key-222"])
    assert "tok-111" not in result
    assert "key-222" not in result


def test_empty_secret_list_leaves_text_unchanged():
    text = "no secrets here"
    assert redact_secrets(text, []) == text


def test_none_and_empty_string_secrets_are_ignored_not_erroring():
    text = "some message"
    assert redact_secrets(text, [None, ""]) == text


def test_text_without_the_secret_is_unchanged():
    text = "unrelated error message"
    assert redact_secrets(text, ["some-secret"]) == text
