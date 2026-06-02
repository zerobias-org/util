import Generator from 'yeoman-generator';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export default class extends Generator {
  constructor(args, opts) {
    super(args, opts);

    this.option('links', { type: Boolean, default: true });
    this.option('install', { type: Boolean, default: true });

    this.argument('productPackage', { type: String, required: false });
    this.argument('modulePackage', { type: String, required: false });
    this.argument('packageVersion', { type: String, required: false });
    this.argument('description', { type: String, required: false });
    this.argument('repository', { type: String, required: false });
    this.argument('author', { type: String, required: false });
    this.argument('moduleType', { type: String, required: false });
  }

  async initializing() {
    const currentPackageJson = this.fs.readJSON(this.destinationPath('package.json'), {});
    const packageName = currentPackageJson.name || 'package';
    if (!packageName.endsWith('/module')) {
      throw new Error('You must run this generator from the root of a package');
    }

    if (this.options.install) {
      const docker = spawnSync('docker', ['info'], { stdio: 'ignore' });
      if (docker.status !== 0) {
        throw new Error(
          'Docker is not running. The gradle build requires Docker for buildImage. ' +
          'Start Docker Desktop and re-run, or pass --no-install to scaffold without building.'
        );
      }
    }
  }

  async prompting() {
    const { productPackage } = this.options.productPackage
      ? { productPackage: this.options.productPackage }
      : await this.prompt([
          {
            type: 'input',
            name: 'productPackage',
            message: 'Product package',
            default: '@zerobias-org/product-github-github',
            store: false,
          },
        ]);
    this.answers = await this.prompt(
      [
        {
          type: 'input',
          name: 'modulePackage',
          message: 'Module package',
          default: productPackage.replace('product-', 'module-').replace('@zerobias-org/', '@auditlogic/'),
        },
        {
          type: 'input',
          name: 'packageVersion',
          message: 'Starting version',
          default: '0.0.0',
        },
        {
          type: 'input',
          name: 'description',
          message: 'Display name',
        },
        {
          type: 'input',
          name: 'repository',
          message: 'Repository URL',
          store: true,
        },
        {
          type: 'input',
          name: 'author',
          message: 'Author Email',
          store: true,
        },
        {
          type: 'list',
          name: 'moduleType',
          message: 'Module type',
          choices: [
            { name: 'connector (has connection profile)', value: 'connector' },
            { name: 'non-connector (no connection profile)', value: 'plain' },
          ],
          default: 'connector',
        },
      ].filter((x) => !this.options[x.name])
    );

    for (const key of ['modulePackage', 'packageVersion', 'description', 'repository', 'author', 'moduleType']) {
      if (this.options[key]) {
        this.answers[key] = this.options[key];
      }
    }

    this.answers.productPackage = productPackage.toLowerCase();
  }

  _camelize(str) {
    return str.replace(/\W+(.)/g, (_, chr) => chr.toUpperCase());
  }

  _relativePath() {
    return `/package/${this.answers.modulePackage.split('/module-')[1].split('-').join('/')}`;
  }

  _path() {
    return `${this.destinationRoot()}${this._relativePath()}`;
  }

  _package() {
    return `${this._relativePath().substring('/package/'.length).replace(/\//g, '.')}.module`;
  }

  _packageName() {
    return this.answers.modulePackage.split('/').at(-1);
  }

  _gradleProjectPath() {
    return `:${this._relativePath().substring('/package/'.length).replace(/\//g, ':')}`;
  }

  configuring() {
    if (!this.answers.productPackage.includes('/product-')) {
      throw new Error("Product package must be in the format '@<scope>/product-<vendor>-<suite?>-<service>'");
    }

    if (!this.answers.productPackage.startsWith('@zerobias-org/')) {
      this.log(`⚠️  Product packages have moved to @zerobias-org. Got '${this.answers.productPackage}'.`);
    }

    if (!this.answers.modulePackage.includes('/module-')) {
      throw new Error("Module package must be in the format '@<scope>/module-<vendor>-<suite?>-<service>-<domain?>'");
    }

    if (!this.answers.modulePackage.startsWith('@auditlogic/')) {
      this.log(`⚠️  Module packages remain on @auditlogic. Got '${this.answers.modulePackage}'.`);
    }

    this.answers.modulePackage = this.answers.modulePackage.toLowerCase();
    this.answers.name = this.answers.modulePackage.split('-').at(-1);
    this.answers.scope = this.answers.modulePackage.split('/').at(0);
    this.answers.apiName = this._camelize(this.answers.name);
    this.answers.className = this.answers.apiName.charAt(0).toUpperCase() + this.answers.apiName.slice(1);
    this.answers.path = this._path();
    this.answers.relativePath = this._relativePath();
    this.answers.repoDirectory = this._relativePath().substring(1);
    this.answers.package = this._package();
    this.answers.packageName = this._packageName();
    this.answers.moduleName = this._packageName().replace('module-', '');
    this.answers.moduleId = randomUUID();
    this.answers.isConnector = this.answers.moduleType === 'connector';
    this.answers.gradleProject = this._gradleProjectPath();
  }

  _copyTemplateFile(src, dest, args) {
    this.fs.copyTpl(
      this.templatePath(src),
      `${this.answers.path}/${dest ? dest : src}`,
      args ? args : this.answers
    );
  }

  writing() {
    if (!fs.existsSync(this.answers.path)) {
      this.log(`Creating path ${this.answers.path}`);
      fs.mkdirSync(this.answers.path, { recursive: true });
    } else {
      throw new Error(`Path ${this.answers.path} already exists, aborting.`);
    }
    this.log('📄 Copying templates...');
    this._copyTemplateFile('gitignore', '.gitignore');
    this._copyTemplateFile('mocharc.json', '.mocharc.json');
    this._copyTemplateFile('README.md');
    this._copyTemplateFile('api.yml');
    this._copyTemplateFile('package.template.json', 'package.json');
    this._copyTemplateFile('tsconfig.json');
    this._copyTemplateFile('build.gradle.kts');
    this._copyTemplateFile('main.ts', `src/${this.answers.className}Impl.ts`);
    this._copyTemplateFile('index.ts', `src/index.ts`);
    this._copyTemplateFile('hub-sdk-package.template.json', 'hub-sdk/package.json');
    this._copyTemplateFile('e2e-constants.template.ts', 'test/e2e/constants.ts');
    this._copyTemplateFile('e2e-test.template.ts', `test/e2e/${this.answers.name}.test.ts`);
    this._copyTemplateFile('unit-test.template.ts', `test/unit/${this.answers.className}ApiTest.ts`);

    if (this.answers.isConnector) {
      this._copyTemplateFile('connectionProfile.yml');
    }
  }

  install() {
    if (this.options.links) {
      this.log('🔗 Creating symlinks...');
      const depth = this.answers.relativePath.split('/').filter(Boolean).length;
      const up = Array(depth).fill('..').join('/');
      fs.symlinkSync(`${up}/.nvmrc`, `${this.answers.path}/.nvmrc`, 'file');
      fs.symlinkSync(`${up}/.npmrc`, `${this.answers.path}/.npmrc`, 'file');
    }

    this.log(`Module location: ${this.answers.path}`);

    if (this.options.install) {
      const gradlew = path.join(this.destinationRoot(), 'gradlew');
      if (!fs.existsSync(gradlew)) {
        throw new Error(`No gradlew at ${gradlew} — run the generator from a repo with gradle infrastructure.`);
      }
      this.log(`🏗  Building via Gradle: ./gradlew ${this.answers.gradleProject}:build`);
      const result = spawnSync(gradlew, [`${this.answers.gradleProject}:build`], {
        cwd: this.destinationRoot(),
        stdio: 'inherit',
      });
      if (result.status !== 0) {
        throw new Error(`Gradle build failed (exit ${result.status})`);
      }
    }
  }
}
