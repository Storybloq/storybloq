SECRET_KEY = "fixture-only-not-a-secret"
DEBUG = True
INSTALLED_APPS = ["django.contrib.contenttypes", "django.contrib.auth", "bookings"]
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": "db.sqlite3"}}
USE_TZ = True
