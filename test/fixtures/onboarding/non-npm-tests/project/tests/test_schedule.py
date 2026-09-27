from rota.schedule import assign


def test_assign_rotates() -> None:
    assert assign(["a", "b"], ["mon", "tue", "wed"]) == {"mon": "a", "tue": "b", "wed": "a"}
