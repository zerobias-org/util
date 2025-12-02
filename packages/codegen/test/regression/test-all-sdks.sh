#!/bin/bash

# Test all Platform SDK YAML specs with api-client generator
# This provides regression testing for codegen without external dependencies
# Ensures all generated TypeScript code compiles successfully

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR="$SCRIPT_DIR"
OUTPUT_BASE_DIR="$TEST_DIR/output"

# Clean previous test outputs
rm -rf "$OUTPUT_BASE_DIR"
mkdir -p "$OUTPUT_BASE_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🧪 Running Platform SDK Regression Tests"
echo "========================================"

# Test specs
SPECS=(
    "store.yml"
    "platform.yml" 
    "graphql.yml"
    "portal.yml"
    "dataloader.yml"
    "platform-events.yml"
)

# Create a TypeScript config for testing
create_tsconfig() {
    local output_dir="$1"
    cat > "$output_dir/tsconfig.json" << 'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020", "DOM"],
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./",
    "strict": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "node",
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": [
    "**/*.ts"
  ],
  "exclude": [
    "node_modules",
    "dist"
  ]
}
EOF
}

# Create package.json with required dependencies
create_package_json() {
    local output_dir="$1"
    local spec_name="$2"
    cat > "$output_dir/package.json" << EOF
{
  "name": "test-$spec_name-sdk",
  "version": "1.0.0",
  "description": "Generated SDK test for $spec_name",
  "main": "api/index.js",
  "types": "api/index.d.ts",
  "dependencies": {
    "@auditmation/types-core-js": "^4.9.6",
    "@auditmation/util-api-client-base": "^1.1.3",
    "jsonata": "1.8.6",
    "axios": "^0.27.2"
  },
  "devDependencies": {
    "@types/node": "16.18.71",
    "typescript": "^4.8.4"
  }
}
EOF
}

# Install real dependencies
install_dependencies() {
    local output_dir="$1"
    echo "   Installing dependencies..."
    cd "$output_dir"
    if npm install --no-audit --no-fund > npm-install.log 2>&1; then
        echo -e "   ✅ Dependencies installed successfully"
    else
        echo -e "   ⚠️  ${YELLOW}Warning: Some dependencies failed to install${NC}"
        # Continue anyway as tests might still pass with partial dependencies
    fi
}

# Function to test a single spec
test_spec() {
    local spec_file="$1"
    local spec_name="${spec_file%.*}"
    local output_dir="$OUTPUT_BASE_DIR/$spec_name"
    
    echo -e "\n📋 Testing: ${YELLOW}$spec_file${NC}"
    
    if [ ! -f "$TEST_DIR/$spec_file" ]; then
        echo -e "❌ ${RED}SKIP${NC}: $spec_file not found"
        return 1
    fi
    
    mkdir -p "$output_dir"
    
    # Generate with api-client generator
    if hub-generator generate -g api-client -i "$TEST_DIR/$spec_file" -o "$output_dir/" --skip-validate-spec > "$output_dir/generation.log" 2>&1; then
        echo -e "✅ ${GREEN}Generated successfully${NC}"
        
        # Check if critical files were created
        if [ -f "$output_dir/model/index.ts" ] && [ -f "$output_dir/api/index.ts" ]; then
            echo -e "   ✅ Required files generated"
            
            # Create TypeScript environment
            create_tsconfig "$output_dir"
            create_package_json "$output_dir" "$spec_name"
            install_dependencies "$output_dir"
            
            # Try to compile TypeScript
            cd "$output_dir"
            if npx tsc > compile.log 2>&1; then
                echo -e "   ✅ ${GREEN}TypeScript compilation successful${NC}"
                
                # Check for enum reference consistency
                if grep -q "Property '.*EnumDef' does not exist" compile.log 2>/dev/null; then
                    echo -e "   ⚠️  ${YELLOW}Warning: Enum reference issues detected${NC}"
                    echo "   See: $output_dir/compile.log"
                fi
                
                return 0
            else
                echo -e "   ❌ ${RED}TypeScript compilation failed${NC}"
                echo "   Errors:"
                head -20 "$output_dir/compile.log" | sed 's/^/      /'
                if [ $(wc -l < "$output_dir/compile.log") -gt 20 ]; then
                    echo "      ... (see $output_dir/compile.log for full output)"
                fi
                return 1
            fi
        else
            echo -e "   ❌ ${RED}Missing required output files${NC}"
            return 1
        fi
    else
        echo -e "❌ ${RED}Generation failed${NC}"
        echo "   Errors:"
        tail -10 "$output_dir/generation.log" | sed 's/^/   /'
        return 1
    fi
}

# Run tests
failed_count=0
total_count=0

for spec in "${SPECS[@]}"; do
    total_count=$((total_count + 1))
    if ! test_spec "$spec"; then
        failed_count=$((failed_count + 1))
    fi
done

echo -e "\n📊 Test Results"
echo "==============="
echo -e "Total: $total_count"
echo -e "Passed: $((total_count - failed_count))"
echo -e "Failed: $failed_count"

if [ $failed_count -eq 0 ]; then
    echo -e "\n🎉 ${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "\n💥 ${RED}$failed_count test(s) failed${NC}"
    exit 1
fi