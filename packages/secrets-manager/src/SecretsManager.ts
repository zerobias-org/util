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
   * @returns the value at the given node in the secrets tree
   */
  getValue(path: string): Promise<SecretType>;

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
