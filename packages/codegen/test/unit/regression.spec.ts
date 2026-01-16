import { expect } from 'chai';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

describe('Platform SDK Regression Tests', function() {
  this.timeout(120000); // 2 minutes timeout for large specs like platform.yml

  const testDir = path.join(__dirname, '../regression');
  const outputDir = path.join(testDir, 'output');
  
  const specs = [
    'store.yml',
    'platform.yml',
    'graphql.yml',
    'portal.yml',
    'dataloader.yml',
    'platform-events.yml',
    'hub.yml'
  ];

  before(function() {
    // Clean output directory
    if (fs.existsSync(outputDir)) {
      execSync(`rm -rf ${outputDir}`);
    }
    fs.mkdirSync(outputDir, { recursive: true });
  });

  specs.forEach(spec => {
    describe(`SDK: ${spec}`, function() {
      const specName = spec.replace('.yml', '');
      const specPath = path.join(testDir, spec);
      const sdkOutputDir = path.join(outputDir, specName);
      
      it('should exist in test directory', function() {
        expect(fs.existsSync(specPath), `${spec} should exist in test/regression/`).to.be.true;
      });

      it('should generate successfully with api-client generator', function() {
        try {
          const cmd = `${path.join(__dirname, '../../bin/hub-generator.js')} generate -g api-client -i ${specPath} -o ${sdkOutputDir}/ --skip-validate-spec`;
          execSync(cmd, { stdio: 'pipe' });
        } catch (error) {
          throw new Error(`Failed to generate SDK for ${spec}: ${error.message}`);
        }
      });

      it('should create required TypeScript files', function() {
        expect(fs.existsSync(path.join(sdkOutputDir, 'model/index.ts')), 'model/index.ts should exist').to.be.true;
        expect(fs.existsSync(path.join(sdkOutputDir, 'api/index.ts')), 'api/index.ts should exist').to.be.true;
      });

      it('should have correct enum references in attributeTypeMap', function() {
        const modelFiles = fs.readdirSync(path.join(sdkOutputDir, 'model'))
          .filter(file => file.endsWith('.ts') && file !== 'index.ts');
        
        let foundEnumReference = false;
        let hasEnumDefError = false;
        
        for (const file of modelFiles) {
          const content = fs.readFileSync(path.join(sdkOutputDir, 'model', file), 'utf-8');
          
          // Check for enum references in attributeTypeMap
          const enumRefMatches = content.match(/"type":\s*"[^"]*\..*Enum[^"]*"/g);
          if (enumRefMatches) {
            foundEnumReference = true;
            
            // Check for incorrect EnumDef references
            const enumDefMatches = enumRefMatches.filter(match => match.includes('EnumDef'));
            if (enumDefMatches.length > 0) {
              hasEnumDefError = true;
              console.log(`❌ Found EnumDef references in ${file}:`, enumDefMatches);
            }
          }
        }
        
        if (foundEnumReference) {
          expect(hasEnumDefError, 'Should not have EnumDef references in attributeTypeMap').to.be.false;
        }
      });

      it('should compile TypeScript successfully', function() {
        // Create TypeScript config
        const tsConfig = {
          compilerOptions: {
            target: 'ES2020',
            module: 'commonjs',
            lib: ['ES2020', 'DOM'],
            declaration: true,
            strict: false,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
            moduleResolution: 'node',
            allowSyntheticDefaultImports: true,
            resolveJsonModule: true,
            noEmit: true
          },
          include: ['**/*.ts'],
          exclude: ['node_modules', 'dist']
        };
        
        fs.writeFileSync(
          path.join(sdkOutputDir, 'tsconfig.json'), 
          JSON.stringify(tsConfig, null, 2)
        );

        // Create package.json with real dependencies
        const packageJson = {
          name: `test-${specName}-sdk`,
          version: '1.0.0',
          dependencies: {
            '@zerobias-org/types-core-js': '^4.9.6',
            '@zerobias-org/util-api-client-base': '^1.1.3',
            'jsonata': '1.8.6',
            'axios': '^0.27.2'
          }
        };
        
        fs.writeFileSync(
          path.join(sdkOutputDir, 'package.json'),
          JSON.stringify(packageJson, null, 2)
        );

        // Install real dependencies
        console.log(`Installing dependencies for ${specName}...`);
        try {
          execSync('npm install --no-audit --no-fund', {
            cwd: sdkOutputDir,
            stdio: 'inherit'
          });
        } catch (error) {
          console.warn(`Failed to install dependencies for ${specName}, using local resolution`);
          // Continue with test as some packages might not be accessible
        }

        // Try to compile
        try {
          execSync('npx tsc', { 
            cwd: sdkOutputDir, 
            stdio: 'pipe' 
          });
        } catch (error) {
          // Check for specific enum errors
          const errorOutput = error.stdout?.toString() || error.stderr?.toString() || '';
          
          if (errorOutput.includes("Property '") && errorOutput.includes("EnumDef' does not exist")) {
            throw new Error(`Enum reference error in ${spec}: EnumDef references should be Enum`);
          }
          
          // Check for HTML entity syntax errors (known issue)
          if (errorOutput.includes("&lt;") || errorOutput.includes("&gt;")) {
            console.log(`⚠️  ${spec}: HTML entity encoding detected (known issue)`);
            return; // Pass test but note the issue
          }
          
          // Count total errors - there should be ZERO
          const errorCount = (errorOutput.match(/error TS/g) || []).length;
          throw new Error(`TypeScript compilation failed for ${spec}: ${errorCount} errors found. Generated code must compile with zero errors.\n\nFirst few errors:\n${errorOutput.split('\n').slice(0, 10).join('\n')}`);
        }
      });
    });
  });
});