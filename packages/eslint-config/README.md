# eslint-config
Devsupply eslint configuration

# Usage
## Install peer dependencies
In your project directory:
```
npm i -D @devsupply/eslint-config @typescript-eslint/eslint-plugin @typescript-eslint/parser eslint-config-airbnb-typescript eslint-plugin-import eslint
```

## Add a .eslintrc to the project

Note that this must be at the same level as your `package.json` (i.e. - the root of the module/project).

```json
{
  "extends": "@devsupply"
}
```

## Add scripts to the package.json file to run and fix lint issues
```
"lint": "eslint src",
"lint:test": "eslint test",
"lint:fix": "eslint src --fix",
```
