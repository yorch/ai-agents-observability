export type RedactionRule = {
  apply: (text: string) => { text: string; triggered: boolean };
  name: string;
};
