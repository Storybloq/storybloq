def assign(volunteers: list[str], shifts: list[str]) -> dict[str, str]:
    """Assign shifts to volunteers in turn."""
    if not volunteers:
        raise ValueError("no volunteers")
    return {shift: volunteers[i % len(volunteers)] for i, shift in enumerate(shifts)}
