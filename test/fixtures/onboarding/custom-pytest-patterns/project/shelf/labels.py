def label_text(call_number: str, author: str) -> str:
    """The text on one spine label: the call number over the author's surname."""
    surname = author.split()[-1] if author.strip() else ""
    return f"{call_number}\n{surname[:3].upper()}"
