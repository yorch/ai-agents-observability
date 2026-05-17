export type RedactionRule = {
  apply: (text: string) => { text: string; triggered: boolean };
  name: string;
};

export function makeRule(name: string, regex: RegExp): RedactionRule {
  return {
    apply(text: string) {
      let triggered = false;
      const result = text.replace(regex, () => {
        triggered = true;
        return `[REDACTED:${name}]`;
      });
      return { text: result, triggered };
    },
    name,
  };
}
