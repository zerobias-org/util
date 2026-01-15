# @zerobias-org/hub-module-utils

## Table of contents

### Functions

- [camelCase](#camelCase)
- [convertBooleans](#convertBooleans)
- [convertNumbers](#convertNumbers)
- [getAttributes](#getAttributes)
- [getBasicAuthHeader](#getBasicAuthHeader)
- [pascalCase](#pascalCase)
- [snakeCase](#snakeCase)

### Variables

- [camelCaseAllPropertyNames](#camelCaseAllPropertyNames)
- [removeEmptyStrings](#removeEmptyStrings)
- [snakeCaseAllPropertyNames](#snakeCaseAllPropertyNames)

### Mappers
- [map](#map)
- [toEnum](#toEnum)

## Functions

### camelCase

▸ **camelCase**(`input`): string

Returns The `camelCase` form of the input string.

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | string |

#### Returns

string

___

### convertBooleans

▸ **convertBooleans**<`BodyType`\>(`body`, `modelName`, `modelPath?`): BodyType

Converts all its properties returned by `getAttributes(modelName,'boolean',modelPath)` to type `boolean`.

#### Type parameters

| Name |
| :------ |
| `BodyType` |

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `body` | BodyType | Input body. |
| `modelName` | string | The name of the model. |
| `modelPath?` | string | Optional: Override the model path. |

#### Returns

BodyType

The value of the input with converted number values.

___

### convertNumbers

▸ **convertNumbers**<`BodyType`\>(`body`, `modelName`, `modelPath?`): BodyType

Converts all its properties returned by `getAttributes(modelName,'number',modelPath)` to type `number`.

#### Type parameters

| Name |
| :------ |
| `BodyType` |

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `body` | BodyType | Input body. |
| `modelName` | string | The name of the model. |
| `modelPath?` | string | Optional: Override the model path. |

#### Returns

BodyType

The value of the input with converted number values.

___

### getAttributes

▸ **getAttributes**(`modelName`, `type`, `modelPath?`): string[]

Returns a list of all attributes of specified type in the specified model.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `modelName` | string | The name of the model. |
| `type` | string | The type of the attributes to return. |
| `modelPath?` | string | Optional: Override the model path |

#### Returns

string[]

An array of attribute names.

___

### getBasicAuthHeader

▸ **getBasicAuthHeader**(`username?`, `password?`): string

Creates a Basic Authentication header value out of given username and password.

#### Parameters

| Name | Type |
| :------ | :------ |
| `username?` | string |
| `password?` | string |

#### Returns

string

Authentication header

___

### pascalCase

▸ **pascalCase**(`input`): string

Returns The `PascalCase` form of the input string.

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | string |

#### Returns

string

___

### snakeCase

▸ **snakeCase**(`input`): string

Returns The `snake_case` form of the input string.

#### Parameters

| Name | Type |
| :------ | :------ |
| `input` | string |

#### Returns

string

## Variables

### camelCaseAllPropertyNames
Jsonata transform expression that renames all `input.body` object properties to `CamelCase`.  
It requires [camelCase](#camelCase) function registered.

___

### removeEmptyStrings
Jsonata transform expression that removes all input object properties with empty string value.

___

### snakeCaseAllPropertyNames
Jsonata transform expression that renames all `input.body` object properties to `snake_case`.  
It requires [snakeCase](#snakeCase) function registered.

## Mappers

### map

▸ **map**<`I`\,`O`\>(`OutputType`, `value`, `dflt`): O

If `value` is not `undefined`, returns a new instance of `OutputType` with the value of `value`.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `OutputType` | `{new(arg:I):O;}` | The class to instantiate. |
| `value?` | string | The value to instantiate with. |
| `dflt?` | `O` | The value to return when value is `undefined`. Default: `undefined`. |

___

### toEnum

▸ **toEnum**<`T`\,`K extends keyof T`\>(`Enum`, `value`, `transformFunction`): T[K]

Transforms the input and returns the enum value matching the result.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `Enum` | `T` | The enum to convert to.. |
| `value?` | string | The string value for the enum. |
| `transformFunction?` |  `(arg:string)=>string` | Override transform function. The default transform function is `snakeCase`. |
#### Returns

T[K]

The enum value that matches the transformed input value.
