// Base URL of the ingest service. Single source of truth shared by the flusher
// (POST /v1/events) and the transcript shipper (POST /v1/transcripts) so the
// default endpoint can't drift between them.
export const INGEST_BASE_URL = process.env.INGEST_BASE_URL ?? 'http://localhost:4000';
