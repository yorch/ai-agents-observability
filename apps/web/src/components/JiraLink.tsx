// Renders a Jira issue key — linked to `${jiraBase}/browse/${jiraKey}` when a
// base URL is configured, plain text otherwise. Pure markup (no hooks), so it
// works in both server and client components. Pass `jiraBase` from
// getJiraBase() (client components receive it as a prop from their page).
export function JiraLink({
  jiraBase,
  jiraKey,
  className = 'text-blue-400 hover:text-blue-300',
  plainClassName = 'text-white/80',
}: {
  className?: string;
  jiraBase: string | null;
  jiraKey: string;
  plainClassName?: string;
}) {
  if (!jiraBase) {
    return <span className={plainClassName}>{jiraKey}</span>;
  }
  return (
    <a
      href={`${jiraBase}/browse/${jiraKey}`}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {jiraKey}
    </a>
  );
}
