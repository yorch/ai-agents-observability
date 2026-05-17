export type AppEnv = {
  Variables: {
    requestId: string;
    user?: { expiresAt: Date | null; id: string; kind: 'hook' };
  };
};
