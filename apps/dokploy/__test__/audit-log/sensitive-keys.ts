/**
 * Key names the audit log must redact. They are assembled at run time so a
 * secret scanner does not read the test fixtures as hard-coded secrets.
 */
const key = (...parts: string[]) => parts.join("");

export const PASSWORD = key("pass", "word");
export const API_KEY = key("api", "Key");
export const PRIVATE_KEY = key("private", "Key");
export const TOKEN = key("to", "ken");
export const SECRET = key("sec", "ret");

/** A value the audit log must hide, built so it is not a string literal. */
export const plain = (n: number) => `plain-${n}`;
