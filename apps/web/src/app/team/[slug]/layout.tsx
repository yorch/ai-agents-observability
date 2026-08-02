// Navigation for this scope lives in the rail (components/shell/nav-model.ts),
// and the root layout owns the content measure — so this layout is a pass-through.
export default function TeamLayout({ children }: { children: React.ReactNode }) {
  return children;
}
