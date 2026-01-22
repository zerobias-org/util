/**
 * Nested object path utilities for DataProducer implementations
 *
 * Provides utilities for accessing and manipulating nested object properties
 * using dot notation and array paths.
 *
 * @packageDocumentation
 */

/**
 * Path utilities for nested object access
 *
 * Supports:
 * - Dot notation: `user.address.city`
 * - Array paths: `addresses[].street`
 * - Mixed paths: `users[].profile.name`
 */
export const PathUtils = {
  /**
   * Gets a nested value from an object using dot notation
   *
   * @param obj - Source object
   * @param path - Path to property (e.g., 'user.address.city')
   * @returns Value at path or undefined if not found
   *
   * @example
   * ```typescript
   * const obj = { user: { address: { city: 'Boston' } } };
   * PathUtils.getNestedValue(obj, 'user.address.city')  // 'Boston'
   * PathUtils.getNestedValue(obj, 'user.phone')         // undefined
   * ```
   */
  getNestedValue(obj: any, path: string): any {
    if (!path) {
      return obj;
    }

    if (obj === null || obj === undefined) {
      return undefined;
    }

    // Handle array paths
    if (path.includes('[]')) {
      return this.getArrayItemValues(obj, path);
    }

    const parts = path.split('.');
    let current = obj;

    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }

    return current;
  },

  /**
   * Sets a nested value in an object using dot notation
   *
   * Creates intermediate objects as needed.
   *
   * @param obj - Target object
   * @param path - Path to property
   * @param value - Value to set
   *
   * @example
   * ```typescript
   * const obj = {};
   * PathUtils.setNestedValue(obj, 'user.address.city', 'Boston');
   * // obj is now { user: { address: { city: 'Boston' } } }
   * ```
   */
  setNestedValue(obj: any, path: string, value: any): void {
    if (!path || obj === null || obj === undefined) {
      return;
    }

    const parts = path.split('.');
    let current = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];

      if (!(part in current) || typeof current[part] !== 'object') {
        current[part] = {};
      }

      current = current[part];
    }

    current[parts.at(-1)] = value;
  },

  /**
   * Gets values from array items
   *
   * Handles paths like:
   * - `addresses[].street` - Returns array of all street values
   * - `users[].profile.name` - Returns array of all profile names
   *
   * @param obj - Source object
   * @param path - Path with array notation
   * @returns Array of values
   *
   * @example
   * ```typescript
   * const obj = {
   *   addresses: [
   *     { street: '123 Main St', city: 'Boston' },
   *     { street: '456 Oak Ave', city: 'NYC' }
   *   ]
   * };
   * PathUtils.getArrayItemValues(obj, 'addresses[].street')
   * // ['123 Main St', '456 Oak Ave']
   * ```
   */
  getArrayItemValues(obj: any, path: string): any[] {
    if (!path.includes('[]')) {
      return [];
    }

    // Split only on first occurrence: "addresses[].street" -> ["addresses", "street"]
    // For nested: "departments[].employees[].name" -> ["departments", "employees[].name"]
    const arrayMarkerIndex = path.indexOf('[]');
    const arrayPath = path.slice(0, Math.max(0, arrayMarkerIndex));
    const itemPath = path.slice(Math.max(0, arrayMarkerIndex + 3)); // Skip past '[].

    // Get the array
    const array = this.getNestedValue(obj, arrayPath);

    if (!Array.isArray(array)) {
      return [];
    }

    // Extract the property from each item
    if (itemPath) {
      // If itemPath contains more array notation, recursively process it
      if (itemPath.includes('[]')) {
        // Flatten results from nested arrays
        return array.flatMap(item => this.getArrayItemValues(item, itemPath));
      }
      return array.map(item => this.getNestedValue(item, itemPath));
    }

    return array;
  },

  /**
   * Sets values in array items
   *
   * @param obj - Target object
   * @param path - Path with array notation
   * @param values - Array of values to set
   *
   * @example
   * ```typescript
   * const obj = {
   *   addresses: [
   *     { street: '123 Main St' },
   *     { street: '456 Oak Ave' }
   *   ]
   * };
   * PathUtils.setArrayItemValues(obj, 'addresses[].city', ['Boston', 'NYC']);
   * // addresses[0].city is now 'Boston'
   * // addresses[1].city is now 'NYC'
   * ```
   */
  setArrayItemValues(obj: any, path: string, values: any[]): void {
    if (!path.includes('[]') || !Array.isArray(values)) {
      return;
    }

    const [arrayPath, itemPath] = path.split('[].');

    const array = this.getNestedValue(obj, arrayPath);

    if (!Array.isArray(array)) {
      return;
    }

    if (itemPath) {
      for (const [index, item] of array.entries()) {
        if (index < values.length) {
          this.setNestedValue(item, itemPath, values[index]);
        }
      }
    } else {
      // Replace entire array
      this.setNestedValue(obj, arrayPath, values);
    }
  },

  /**
   * Checks if a path exists in an object
   *
   * @param obj - Source object
   * @param path - Path to check
   * @returns True if path exists and has a non-null value
   *
   * @example
   * ```typescript
   * const obj = { user: { name: 'John' } };
   * PathUtils.hasPath(obj, 'user.name')   // true
   * PathUtils.hasPath(obj, 'user.email')  // false
   * ```
   */
  hasPath(obj: any, path: string): boolean {
    const value = this.getNestedValue(obj, path);
    return value !== undefined && value !== null;
  },

  /**
   * Deletes a nested property from an object
   *
   * @param obj - Target object
   * @param path - Path to property
   * @returns True if property was deleted
   *
   * @example
   * ```typescript
   * const obj = { user: { name: 'John', email: 'john@example.com' } };
   * PathUtils.deletePath(obj, 'user.email');
   * // obj is now { user: { name: 'John' } }
   * ```
   */
  deletePath(obj: any, path: string): boolean {
    if (!path || obj === null || obj === undefined) {
      return false;
    }

    const parts = path.split('.');
    let current = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];

      if (!(part in current) || typeof current[part] !== 'object') {
        return false;
      }

      current = current[part];
    }

    const lastPart = parts.at(-1);
    if (lastPart in current) {
      delete current[lastPart];
      return true;
    }

    return false;
  },
};
