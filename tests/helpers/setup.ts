// Point every module at the throwaway test database before anything imports the db client.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://venture:venture_dev_password@localhost:5433/venture_stream_test";
process.env.APP_URL = "http://localhost:3000";
