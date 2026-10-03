-- Runs once when the Postgres volume is first initialised.
-- A separate database for the automated test suite so tests never touch dev data.
CREATE DATABASE parley_test OWNER parley;
