import json
from concurrent.futures import ThreadPoolExecutor
from functools import partial

import pytest

from services import telegram_tokens


@pytest.fixture(params=["links", "actions"])
def tokens(request, tmp_path):
    path = tmp_path / "tokens.json"
    if request.param == "links":
        create = partial(telegram_tokens.create_telegram_link, str(path),
                         company_code="A", principal_id="worker-1",
                         max_age_seconds=10, now=100, principal_type="worker")
        read = partial(telegram_tokens.telegram_link_record, str(path), now=101)
        identity_change = {"principal_id": "worker-2"}
        version = 2
    else:
        create = partial(telegram_tokens.create_telegram_payment_action, str(path),
                         company_code="A", worker_id="worker-1", subject_id="worker-1",
                         submission_id="invoice-1", chat_id="chat-1", max_age_seconds=10, now=100)
        read = partial(telegram_tokens.telegram_payment_action_record, str(path), now=101)
        identity_change = {"chat_id": "chat-2"}
        version = 1
    return path, create, read, request.param, version, identity_change


def test_replacement_is_scoped_and_file_format_is_preserved(tokens):
    path, create, read, key, version, identity_change = tokens
    old, _ = create()
    peer, _ = create(**identity_change)
    other_company, _ = create(company_code="B")
    current, expires = create()
    assert read(old) is None
    assert read(peer) and read(other_company) and read(current)
    assert expires == 110
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["version"] == version
    assert set(saved[key]) == {peer, other_company, current}


def test_reads_are_detached_and_expiry_is_persisted(tokens):
    path, create, read, key, _, _ = tokens
    token, _ = create()
    record = read(token)
    record["companyCode"] = "changed"
    assert read(token)["companyCode"] == "A"
    assert read(token, now=110) is None
    assert json.loads(path.read_text(encoding="utf-8"))[key] == {}


def test_concurrent_consumption_succeeds_once(tokens):
    _, create, read, _, _, _ = tokens
    token, _ = create()
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: read(token, consume=True), range(16)))
    assert sum(row is not None for row in results) == 1
    assert read(token) is None


def test_failed_replace_preserves_previous_tokens_and_removes_temp_file(tokens, monkeypatch):
    path, create, read, _, _, _ = tokens
    token, _ = create()
    before = path.read_bytes()

    def fail_replace(*args):
        raise OSError("simulated write failure")

    monkeypatch.setattr(telegram_tokens.os, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated write failure"):
        create()
    assert path.read_bytes() == before
    assert read(token)
    assert not list(path.parent.glob("*.tmp"))


def test_invalid_json_can_be_replaced_by_a_valid_token(tokens):
    path, create, read, _, _, _ = tokens
    path.write_text("{invalid", encoding="utf-8")
    assert read("missing") is None
    token, _ = create()
    assert read(token)["companyCode"] == "A"


def test_legacy_user_link_remains_readable_and_is_replaced(tmp_path):
    path = str(tmp_path / "links.json")
    with open(path, "w", encoding="utf-8") as output:
        json.dump({"version": 1, "links": {
            "old": {"companyCode": "A", "username": "admin", "expiresAt": 110},
        }}, output)
    assert telegram_tokens.telegram_link_record(path, "old", now=101)["principalId"] == "admin"
    token, _ = telegram_tokens.create_telegram_link(path, "A", "admin", 10, now=101)
    assert telegram_tokens.telegram_link_record(path, "old", now=101) is None
    assert telegram_tokens.telegram_link_record(path, token, now=101)["username"] == "admin"
