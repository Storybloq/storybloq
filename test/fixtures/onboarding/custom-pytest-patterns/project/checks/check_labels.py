from shelf.labels import label_text


def test_label_text() -> None:
    assert label_text("823.914", "Ann Patchett") == "823.914\nPAT"
