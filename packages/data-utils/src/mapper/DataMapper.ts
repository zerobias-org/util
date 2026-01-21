import jsonata from 'jsonata';
import { JsonataIntegration } from '../transform/JsonataIntegration';
import { SourceField, DestinationField } from './types/field.types';
import {
  MappingRule,
  MappingResult,
  ErrorHandlingStrategy
} from './types/mapping.types';
import {
  TransformConfig,
  ModifierType,
  DataType,
  ParameterizedModifier,
  ConditionalLogic
} from './types/transform.types';
import { ValidationRule } from './types/validation.types';

/**
 * Core data mapper class for creating and executing field mappings
 *
 * Framework-agnostic implementation that can be used in any JavaScript environment
 * (Node.js, React, Vue, Angular, etc.)
 */
export class DataMapper {

  /**
   * Creates a new mapping rule from source to destination
   */
  createMapping(
    source: SourceField,
    destination: DestinationField,
    existingRules: MappingRule[]
  ): MappingRule[] {
    const existingRule = existingRules.find(rule =>
      rule.destination.key === destination.key
    );

    if (existingRule) {
      // Add to existing mapping (convert to array if needed)
      if (Array.isArray(existingRule.source)) {
        // Check if source already exists
        if (!existingRule.source.some(s => s.key === source.key)) {
          existingRule.source.push(source);
          // Auto-switch to combine transform if multiple sources
          if (existingRule.source.length > 1 && existingRule.transform.type === 'direct') {
            existingRule.transform = {
              type: 'combine',
              options: { combineWith: ' ' }
            };
          }
        }
      } else {
        // Convert single source to array and add new source
        if (existingRule.source.key !== source.key) {
          existingRule.source = [existingRule.source, source];
          existingRule.transform = {
            type: 'combine',
            options: { combineWith: ' ' }
          };
        }
      }
      return existingRules;
    } else {
      // Create new mapping
      const newRule: MappingRule = {
        id: this.generateId(),
        source: source,
        destination: destination,
        transform: { type: 'direct' }
      };
      return [...existingRules, newRule];
    }
  }

  /**
   * Removes a mapping rule by ID
   */
  removeMapping(ruleId: string, rules: MappingRule[]): MappingRule[] {
    return rules.filter(rule => rule.id !== ruleId);
  }

  /**
   * Removes a specific source from a mapping
   */
  removeSourceFromMapping(
    mapping: MappingRule,
    sourceToRemove: SourceField,
    rules: MappingRule[]
  ): MappingRule[] {
    const sources = Array.isArray(mapping.source) ? mapping.source : [mapping.source];

    if (sources.length === 1) {
      // If it's the last source, remove the entire mapping
      return this.removeMapping(mapping.id, rules);
    }

    // Remove the specific source from the array
    const updatedSources = sources.filter(source => source.key !== sourceToRemove.key);

    if (updatedSources.length === 1) {
      // Convert back to single source if only one remains
      mapping.source = updatedSources[0];
      // Reset to direct transform if only one source remains
      mapping.transform = { type: 'direct' };
    } else {
      // Keep as array
      mapping.source = updatedSources;
    }

    return rules;
  }

  /**
   * Auto-generates mappings based on field name matching
   */
  autoGenerateMappings(
    sourceFields: SourceField[],
    destinationFields: DestinationField[]
  ): MappingRule[] {
    const rules: MappingRule[] = [];

    destinationFields.forEach(destField => {
      const matchingSource = sourceFields.find(sourceField =>
        this.fieldNamesMatch(sourceField.name, destField.name) ||
        this.fieldNamesMatch(sourceField.key, destField.key)
      );

      if (matchingSource) {
        rules.push({
          id: this.generateId(),
          source: matchingSource,
          destination: destField,
          transform: { type: 'direct' }
        });
      }
    });

    return rules;
  }

  /**
   * Checks if two field names match (normalized comparison)
   */
  private fieldNamesMatch(source: string, dest: string): boolean {
    const normalize = (str: string) => str ? str.toLowerCase().replace(/[_-]/g, '') : '';
    return normalize(source) === normalize(dest);
  }

  /**
   * Applies a mapping rule to source data
   */
  async applyMapping(rule: MappingRule, sourceData: any): Promise<MappingResult> {
    try {
      const sources = Array.isArray(rule.source) ? rule.source : [rule.source];
      let transformedValue: any;

      // Get source values
      const sourceValues = sources.map(source =>
        this.getSourceValue(source, sourceData)
      );

      // Pre-transform validation
      if (rule.transform.validationRules && rule.transform.validationRules.length > 0) {
        const timing = rule.transform.validationTiming || 'both';

        if (timing === 'pre-transform' || timing === 'both') {
          const validationErrors = this.validateValue(sourceValues[0], rule.transform.validationRules);
          if (validationErrors.length > 0) {
            throw new Error(`Pre-transform validation failed: ${validationErrors.join(', ')}`);
          }
        }
      }

      // Apply main transform
      switch (rule.transform.type) {
        case 'direct':
          transformedValue = sourceValues[0];
          break;

        case 'convert':
          const dataType = rule.transform.options?.dataType || 'string';
          const sourceVal = sourceValues[0];
          // Handle array-to-array conversion (convert each element)
          if (Array.isArray(sourceVal)) {
            transformedValue = sourceVal.map(item => this.convertValue(item, dataType));
          } else {
            transformedValue = this.convertValue(sourceVal, dataType);
          }
          break;

        case 'combine':
          const separator = rule.transform.options?.combineWith || ' ';
          transformedValue = sourceValues
            .filter(val => val !== null && val !== undefined && val !== '')
            .join(separator);
          break;

        case 'split':
          const splitOn = rule.transform.options?.splitOn || ',';
          const sourceValue = sourceValues[0]?.toString() || '';
          transformedValue = sourceValue.split(splitOn);
          break;

        case 'expression':
          const expression = rule.transform.options?.expression;
          if (!expression) {
            throw new Error('Expression is required for expression transform');
          }
          transformedValue = await this.evaluateExpression(expression, sources, sourceData);
          break;

        case 'default':
          const value = sourceValues[0];
          const applyOnNull = rule.transform.options?.applyOnNull !== false; // default true
          const applyOnEmpty = rule.transform.options?.applyOnEmpty || false; // default false
          const defaultValue = rule.transform.options?.defaultValue;

          if (applyOnNull && (value === null || value === undefined)) {
            transformedValue = defaultValue;
          } else if (applyOnEmpty && value === '') {
            transformedValue = defaultValue;
          } else {
            transformedValue = value;
          }
          break;

        case 'conditional':
          const sourceForCondition = sourceValues[0];
          const trueValue = rule.transform.options?.trueValue;
          const falseValue = rule.transform.options?.falseValue;

          // Check for advanced conditional logic
          if (rule.transform.options?.advancedCondition) {
            const conditionMet = this.evaluateConditionalLogic(
              sourceForCondition,
              rule.transform.options.advancedCondition
            );
            transformedValue = conditionMet ? trueValue : falseValue;
          }
          // Check for switch/case logic
          else if (rule.transform.options?.switchCases && rule.transform.options.switchCases.length > 0) {
            transformedValue = this.evaluateSwitchCase(
              sourceForCondition,
              rule.transform.options.switchCases,
              rule.transform.options.switchDefault
            );
          }
          // Fall back to simple conditional logic
          else {
            const operator = rule.transform.options?.conditionOperator || 'equals';
            const conditionValue = rule.transform.options?.conditionValue;
            const conditionMet = this.evaluateCondition(sourceForCondition, operator, conditionValue);
            transformedValue = conditionMet ? trueValue : falseValue;
          }
          break;

        case 'lookup':
          const lookupKey = String(sourceValues[0]);
          const lookupTable = rule.transform.options?.lookupTable || {};
          const lookupDefault = rule.transform.options?.lookupDefault;

          if (lookupTable.hasOwnProperty(lookupKey)) {
            transformedValue = lookupTable[lookupKey];
          } else if (lookupDefault !== undefined) {
            transformedValue = lookupDefault;
          } else {
            // Return original value when key not found and no default specified
            transformedValue = sourceValues[0];
          }
          break;

        default:
          transformedValue = sourceValues[0];
      }

      // Apply modifiers
      if (rule.transform.modifiers && rule.transform.modifiers.length > 0) {
        transformedValue = this.applyModifiers(transformedValue, rule.transform.modifiers);
      }

      // Apply parameterized modifiers
      if (rule.transform.parameterizedModifiers && rule.transform.parameterizedModifiers.length > 0) {
        transformedValue = this.applyParameterizedModifiers(transformedValue, rule.transform.parameterizedModifiers);
      }

      // Post-transform validation
      if (rule.transform.validationRules && rule.transform.validationRules.length > 0) {
        const timing = rule.transform.validationTiming || 'both';

        if (timing === 'post-transform' || timing === 'both') {
          const validationErrors = this.validateValue(transformedValue, rule.transform.validationRules);
          if (validationErrors.length > 0) {
            throw new Error(`Post-transform validation failed: ${validationErrors.join(', ')}`);
          }
        }
      }

      return {
        destinationKey: rule.destination.key,
        value: transformedValue,
        success: true
      };
    } catch (error: any) {
      return {
        destinationKey: rule.destination.key,
        value: null,
        success: false,
        error: error.message || 'Unknown error'
      };
    }
  }

  /**
   * Gets the value from source data using the field key or path
   */
  private getSourceValue(source: SourceField, sourceData: any): any {
    // Handle null/undefined source data
    if (sourceData === null || sourceData === undefined) {
      return undefined;
    }

    const key = source.path || source.key;

    // Check if this is an array item field (e.g., "addresses[].street")
    if (key.includes('[]')) {
      return this.getArrayItemValues(key, sourceData);
    }

    // Try direct property access first
    if (sourceData.hasOwnProperty(key)) {
      return sourceData[key];
    }

    // Try nested object access for dot-notation paths
    const parts = key.split('.');
    let value = sourceData;

    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        return undefined;
      }
    }

    return value;
  }

  /**
   * Gets values from array items (e.g., "addresses[].street" returns all street values)
   */
  private getArrayItemValues(path: string, sourceData: any): any[] {
    // Split path: "addresses[].street" -> ["addresses", "street"]
    const [arrayPath, itemPath] = path.split('[].');

    // Get the array
    const array = this.getNestedValue(sourceData, arrayPath);

    if (!Array.isArray(array)) {
      return [];
    }

    // Extract the property from each item
    if (itemPath) {
      return array.map(item => this.getNestedValue(item, itemPath));
    }

    return array;
  }

  /**
   * Gets a nested value from an object using dot notation
   */
  private getNestedValue(obj: any, path: string): any {
    if (!path) {
      return obj;
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
  }

  /**
   * Converts a value to the specified data type
   */
  private convertValue(value: any, dataType: DataType): any {
    if (value === null || value === undefined) {
      return null;
    }

    switch (dataType) {
      case 'boolean':
        return value === 'true' || value === true;

      case 'number':
        const numStr = typeof value === 'string' ? value.replace(/[$,]/g, '') : value;
        const numValue = parseFloat(numStr);
        return isNaN(numValue) ? 0 : numValue;

      case 'date':
        try {
          const dateValue = new Date(value);
          return dateValue.toISOString();
        } catch {
          return null;
        }

      case 'string':
      default:
        return value.toString();
    }
  }

  /**
   * Evaluates a JSONata expression
   */
  private async evaluateExpression(
    expression: string,
    sources: SourceField[],
    sourceData: any
  ): Promise<any> {
    // Build data context
    const dataContext: any = {};

    // Add individual source fields
    sources.forEach(source => {
      const value = this.getSourceValue(source, sourceData);
      dataContext[source.key] = value !== undefined ? value : null;
    });

    // For single source, also provide $source variable
    if (sources.length === 1) {
      dataContext.$source = this.getSourceValue(sources[0], sourceData);
    }

    // Provide all fields as $all
    dataContext.$all = { ...dataContext };

    // Compile and evaluate the JSONata expression
    const compiledExpression = jsonata(expression);

    // Register all transform utilities as JSONata custom functions
    JsonataIntegration.registerFunctions(compiledExpression);

    const result = await compiledExpression.evaluate(dataContext);

    return result;
  }

  /**
   * Applies post-processing modifiers to a value
   * Uses modifiers from @auditmation/zb-client-data-utils package
   */
  private applyModifiers(value: any, modifiers: ModifierType[]): any {
    let result = value;

    for (const modifier of modifiers) {
      const modifierFn = JsonataIntegration.getModifier(modifier);
      if (modifierFn) {
        result = modifierFn(result);
      } else {
        console.warn(`[DataMapper] Unknown modifier: ${modifier}`);
      }
    }

    return result;
  }

  /**
   * Applies parameterized modifiers with runtime configuration
   */
  private applyParameterizedModifiers(value: any, modifiers: ParameterizedModifier[]): any {
    let result = value;

    for (const modifier of modifiers) {
      // Try to use package modifiers first
      const modifierFn = JsonataIntegration.getModifier(modifier.type);

      if (modifierFn) {
        try {
          // Extract parameters based on modifier type
          switch (modifier.type) {
            case 'padLeft':
              result = modifierFn(result, modifier.params?.length, modifier.params?.padChar);
              break;
            case 'round':
              result = modifierFn(result, modifier.params?.decimals);
              break;
            case 'formatCurrency':
              result = modifierFn(result, modifier.params?.currency, modifier.params?.locale);
              break;
            case 'pow':
              result = modifierFn(result, modifier.params?.exponent);
              break;
            case 'log':
              result = modifierFn(result, modifier.params?.base);
              break;
            case 'percentage':
              result = modifierFn(result, modifier.params?.total, modifier.params?.decimals);
              break;
            case 'formatDate':
              result = modifierFn(result, modifier.params?.dateFormat);
              break;
            case 'addDays':
              result = modifierFn(result, modifier.params?.days);
              break;
            case 'subtractDays':
              result = modifierFn(result, modifier.params?.days);
              break;
            case 'join':
              result = modifierFn(result, modifier.params?.separator);
              break;
            case 'slice':
              result = modifierFn(result, modifier.params?.start, modifier.params?.end);
              break;
            default:
              // No parameters, just call the function
              result = modifierFn(result);
              break;
          }
        } catch (error) {
          console.warn(`[DataMapper] Error applying modifier '${modifier.type}':`, error);
        }
      } else {
        // Handle modifiers not yet in package
        switch (modifier.type) {
          case 'extractHour':
            if (result instanceof Date || typeof result === 'string') {
              const date = result instanceof Date ? result : new Date(result);
              result = date.getHours();
            }
            break;
          case 'extractMinute':
            if (result instanceof Date || typeof result === 'string') {
              const date = result instanceof Date ? result : new Date(result);
              result = date.getMinutes();
            }
            break;
          case 'length':
            if (Array.isArray(result) || typeof result === 'string') {
              result = result.length;
            }
            break;
          case 'arrayReverse':
            if (Array.isArray(result)) {
              result = [...result].reverse();
            }
            break;
          case 'padRight':
            if (typeof result === 'string') {
              const length = modifier.params?.length ?? 10;
              const padChar = modifier.params?.padChar ?? ' ';
              result = result.padEnd(length, padChar);
            }
            break;
          default:
            console.warn(`[DataMapper] Unknown modifier: ${modifier.type}`);
            break;
        }
      }
    }

    return result;
  }

  /**
   * Evaluates a condition for conditional transforms
   */
  private evaluateCondition(sourceValue: any, operator: any, compareValue: any): boolean {
    switch (operator) {
      case 'equals':
        return sourceValue == compareValue; // Intentionally using == for loose equality
      case 'notEquals':
        return sourceValue != compareValue;
      case 'greaterThan':
        return sourceValue > compareValue;
      case 'lessThan':
        return sourceValue < compareValue;
      case 'contains':
        if (typeof sourceValue === 'string' && typeof compareValue === 'string') {
          return sourceValue.includes(compareValue);
        }
        return false;
      case 'isEmpty':
        return sourceValue === null || sourceValue === undefined || sourceValue === '';
      case 'isNotEmpty':
        return sourceValue !== null && sourceValue !== undefined && sourceValue !== '';
      default:
        return false;
    }
  }

  /**
   * Evaluates advanced conditional logic with AND/OR and nested conditions
   */
  private evaluateConditionalLogic(sourceValue: any, logic: ConditionalLogic): boolean {
    // If this is a leaf condition (has operator)
    if (logic.operator) {
      return this.evaluateCondition(sourceValue, logic.operator, logic.value);
    }

    // If this is a logical combination (has logicalOperator and conditions)
    if (logic.logicalOperator && logic.conditions && logic.conditions.length > 0) {
      const results = logic.conditions.map(condition =>
        this.evaluateConditionalLogic(sourceValue, condition)
      );

      if (logic.logicalOperator === 'AND') {
        return results.every(result => result);
      } else if (logic.logicalOperator === 'OR') {
        return results.some(result => result);
      }
    }

    // Default: return false if invalid structure
    return false;
  }

  /**
   * Evaluates switch/case logic
   */
  private evaluateSwitchCase(
    sourceValue: any,
    cases: Array<{ condition: any; value: any }>,
    defaultValue: any
  ): any {
    for (const switchCase of cases) {
      if (sourceValue == switchCase.condition) { // Intentionally using == for loose equality
        return switchCase.value;
      }
    }

    return defaultValue;
  }

  /**
   * Validates a value against a set of validation rules
   * Returns an array of error messages (empty if valid)
   */
  private validateValue(value: any, rules: ValidationRule[]): string[] {
    const errors: string[] = [];

    for (const rule of rules) {
      // Skip disabled rules
      if (rule.enabled === false) {
        continue;
      }

      let isValid = true;
      let defaultMessage = '';

      switch (rule.type) {
        case 'required':
          isValid = value !== null && value !== undefined && value !== '';
          defaultMessage = 'This field is required';
          break;

        case 'minLength':
          if (typeof value === 'string' || Array.isArray(value)) {
            const length = rule.config?.length || 0;
            isValid = value.length >= length;
            defaultMessage = `Minimum length is ${length}`;
          }
          break;

        case 'maxLength':
          if (typeof value === 'string' || Array.isArray(value)) {
            const length = rule.config?.length || 0;
            isValid = value.length <= length;
            defaultMessage = `Maximum length is ${length}`;
          }
          break;

        case 'min':
          if (typeof value === 'number') {
            const min = rule.config?.value || 0;
            isValid = value >= min;
            defaultMessage = `Minimum value is ${min}`;
          }
          break;

        case 'max':
          if (typeof value === 'number') {
            const max = rule.config?.value || 0;
            isValid = value <= max;
            defaultMessage = `Maximum value is ${max}`;
          }
          break;

        case 'pattern':
          if (typeof value === 'string' && rule.config?.pattern) {
            try {
              const regex = new RegExp(rule.config.pattern);
              isValid = regex.test(value);
              defaultMessage = 'Value does not match required pattern';
            } catch {
              // Invalid regex, skip validation
              isValid = true;
            }
          }
          break;

        case 'email':
          if (typeof value === 'string') {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            isValid = emailRegex.test(value);
            defaultMessage = 'Invalid email address';
          }
          break;

        case 'url':
          if (typeof value === 'string') {
            try {
              new URL(value);
              isValid = true;
            } catch {
              isValid = false;
              defaultMessage = 'Invalid URL';
            }
          }
          break;

        case 'custom':
          // TODO: Implement custom validation function support
          // For now, skip custom validations
          console.warn('Custom validation functions not yet implemented');
          isValid = true;
          break;
      }

      if (!isValid) {
        errors.push(rule.errorMessage || defaultMessage);
      }
    }

    return errors;
  }

  /**
   * Generates a unique ID for mapping rules
   */
  private generateId(): string {
    return 'mapping_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Sets a value in a nested object using dot notation
   */
  setNestedValue(obj: any, path: string, value: any): void {
    // Handle array item paths (e.g., "locations[].street")
    if (path.includes('[]')) {
      this.setArrayItemValues(obj, path, value);
      return;
    }

    const parts = path.split('.');
    let current = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current)) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }

    current[parts[parts.length - 1]] = value;
  }

  /**
   * Sets values in array items (e.g., "locations[].street" with value ["Main St", "Oak Ave"])
   */
  private setArrayItemValues(obj: any, path: string, values: any): void {
    // Split path: "locations[].street" -> ["locations", "street"]
    const [arrayPath, itemPath] = path.split('[].');

    // Ensure the array exists
    if (!obj[arrayPath]) {
      obj[arrayPath] = [];
    }

    // If values is an array, create/update array items
    if (Array.isArray(values)) {
      // Create objects for each value if needed
      for (let i = 0; i < values.length; i++) {
        if (!obj[arrayPath][i]) {
          obj[arrayPath][i] = {};
        }
        if (itemPath) {
          this.setNestedValue(obj[arrayPath][i], itemPath, values[i]);
        } else {
          obj[arrayPath][i] = values[i];
        }
      }
    } else {
      // Single value, set on first item
      if (!obj[arrayPath][0]) {
        obj[arrayPath][0] = {};
      }
      if (itemPath) {
        this.setNestedValue(obj[arrayPath][0], itemPath, values);
      } else {
        obj[arrayPath][0] = values;
      }
    }
  }

  /**
   * Applies all mapping rules to source data
   */
  async applyAllMappings(
    rules: MappingRule[],
    sourceData: any
  ): Promise<{ result: any; errors: string[] }> {
    const result: any = {};
    const errors: string[] = [];

    for (const rule of rules) {
      // Skip disabled mappings
      if (rule.enabled === false) {
        continue;
      }

      const mappingResult = await this.applyMapping(rule, sourceData);

      if (mappingResult.success) {
        const destPath = rule.destination.path || rule.destination.key;
        this.setNestedValue(result, destPath, mappingResult.value);
      } else {
        // Handle errors based on error strategy
        const errorStrategy = rule.errorStrategy || 'fail';

        switch (errorStrategy) {
          case 'skip':
            // Skip this mapping and continue
            continue;
          case 'default':
            // Use default value
            if (rule.errorDefault !== undefined) {
              const destPath = rule.destination.path || rule.destination.key;
              this.setNestedValue(result, destPath, rule.errorDefault);
            }
            break;
          case 'fail':
          default:
            // Record error and continue (original behavior)
            errors.push(`${rule.destination.name}: ${mappingResult.error}`);
            break;
        }
      }
    }

    return { result, errors };
  }
}
