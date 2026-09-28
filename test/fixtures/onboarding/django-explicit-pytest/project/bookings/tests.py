from bookings.models import Booking


def test_booking_str_fields() -> None:
    booking = Booking(court=1, member="Sam")
    assert booking.court == 1
