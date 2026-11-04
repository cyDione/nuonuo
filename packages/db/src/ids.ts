import { customAlphabet } from 'nanoid'

const alphabet = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)
/** Prefixed ids such as `cnv_k3j2...`, so a model or a person can tell an object's type from its id (Inline & Spill refs). */
export const newId = (prefix: string): string => `${prefix}_${alphabet()}`
