from django.db import models


class Booking(models.Model):
    court = models.PositiveSmallIntegerField()
    starts_at = models.DateTimeField()
    member = models.CharField(max_length=100)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["court", "starts_at"], name="one_booking_per_slot")]
