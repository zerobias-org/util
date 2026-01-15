/**
 * Jsonata transform expression that renames all input object properties to `CamelCase`.
 */
export const camelCaseAllPropertyNames = `
|$.body.**
|(
  $x:=$;
  $merge($.$keys().{$camelCase($):$lookup($x,$)})),
  $append([],$filter($.$keys(),function($k){$k!=$camelCase($k)}))
  |`;

/**
 * Jsonata transform expression that renames all input object properties to `snake_case`.
 */
export const snakeCaseAllPropertyNames = `
  |$.body.**
  |( 
      $x:=$;
      $merge($.$keys().{$snakeCase($): $lookup($x,$)})),
      $append([],$filter($.$keys(),function($k){$k!=$snakeCase($k)}))
  |`;

/**
 * Jsonata transform expression that removes all input object properties with empty string value.
 */
export const removeEmptyStrings = `
  |$.body.**[$type($)="object"]
  |
    {},
    $append([],$filter($.$keys(),function($o){$lookup($,$o)=""}))
  |`;
