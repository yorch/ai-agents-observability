export type AppEnv = {
  Variables: {
    requestId: string;
    user?: { id: string; kind: 'access' | 'hook' | 'refresh' };
  };
};
