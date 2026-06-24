export type UserSummary = {
  email: string | null;
  id: number;
  login: string;
  name: string | null;
};

export type TeamSummary = {
  description: string | null;
  id: number;
  members_count: number;
  name: string;
  slug: string;
};

/** A team the authenticated user belongs to, across all of their orgs. */
export type UserTeamSummary = {
  id: number;
  name: string;
  orgLogin: string;
  role: 'member' | 'maintainer';
  slug: string;
};

export type RepoSummary = {
  default_branch: string;
  full_name: string;
  id: number;
  is_private: boolean;
  name: string;
  owner: string;
  url: string;
};
