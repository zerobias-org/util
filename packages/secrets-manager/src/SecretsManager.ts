import { SecretNode } from '../generated/model/index.js';

export type SecretType = string | number | boolean;

export const DELIMITER = '.';

export interface SecretsManager {

  /**
   * @param path Optional path to list keys from. If not provided, the root level keys are listed.
   * @returns all the keys at the given node in the tree
   */
  listNodes(path?: string): Promise<SecretNode[]>;

  /**
   * @param path the secret node to return the value of
   * @returns the value at the given node in the secrets tree. A leaf whose stored value is a
   *   string is returned verbatim (the stored bytes); a non-string leaf (object/array) is
   *   returned as its JSON serialization.
   */
  getValue(path: string): Promise<SecretType>;

  /**
   * @param value a connection-profile value, which may be a secret path or literal data
   * @returns true when the value addresses a secret in a registered manager. Callers resolving a
   *   profile must gate `getValue` on this: a profile mixes secret paths with literal data, and
   *   `getValue` reads everything before the first delimiter as a provider name.
   */
  isSecretReference(value: string): boolean;

  /**
   * Sets the value at the given path
   *
   * @param path the path to the secret
   * @param value the value to set the secret to
   */
  setValue(
    path: string,
    value: SecretType | Record<string, unknown>
  ): Promise<SecretNode>
}
