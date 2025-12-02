# spectral-config
Devsupply linter configuration for [spectral](https://github.com/stoplightio/spectral)

# Usage
## Install peer dependencies
In your project directory:
```
npm i -D @devsupply/spectral-config 
```

In your project directory or globally:
```
npm install -g @stoplight/spectral
```

## Custom Configuration

`spectral-config` comes with a set of custom rule sets for both `openapi` and `jsonSchema`.

You may also define your own `.spectral.yml` configuration using `spectral`'s configuration options.

*Example configuration file:*
```
extends: "spectral:oas" 
rules:
  enumsMustBeSnakeCase:
    description: Enums must be snake_case.
    given: $..enum[*]
    severity: error
    then:
      function: casing
      functionOptions:
        type: snake
```

## Custom Functions

A set of `custom` functions can be found in the `functions` folder.
To use these add the following properties to your `.spectral.yml` file:
* functions : List of functions to include
* functionsDir : path to custom functions.

```
extends: "spectral:oas" 
functions: [casingExcept]
# any path relative to the ruleset file is okay
functionsDir: "./core/node_modules/@devsupply/spectral-config/functions"
rules:
   ...
```

*functions included:*
| name         | Description  | parameters | examples
| -----------  | -----------  | ---------- | -------
| casingExcept | Applies the core casing rule unless path/propertyName matches one of the included parameter | `ignore-paths`, `ignore-properties` : Arrays | ignore-paths: [components.schemas.Registration], ignore-properties: [biosUUIDS]


## Add scripts to the package.json file to run and fix lint issues
*JSON Schema*
```
"lint:api": "spectral lint ./schema/**/*.yml -v --resolver node_modules/@devsupply/spectral-config/index.js -r node_modules/@devsupply/spectral-config/rules/.jsonschema.spectral.yml"
```

*OpenAPI*

```
"lint:api": "spectral lint ./api.yml -v --resolver node_modules/@devsupply/spectral-config/index.js -r node_modules/@devsupply/spectral-config/rules/.oas3.strict.spectral.yml",
```
