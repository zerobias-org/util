package io.zerobias.hub.module.codegen;

import java.io.File;
import org.openapitools.codegen.CliOption;
import org.openapitools.codegen.CodegenType;
import org.openapitools.codegen.SupportingFile;

public class HubModuleServerGenerator extends HubModuleCodegenGenerator {

    public static final String MODULE_PACKAGE = "modulePackage";

    public HubModuleServerGenerator() {

        outputFolder = "generated-code/hub-module-server";
        embeddedTemplateDir = templateDir = "hub-module-server";
        apiTemplateFiles.put("api-single.mustache", ".ts");
        apiPackage = "server";
        modelTemplateFiles.clear();

        this.cliOptions.add(new CliOption(MODULE_PACKAGE, "The package containing the module definition and implementation"));
    }

    @Override
    public CodegenType getTag() {
        return CodegenType.SERVER;
    }

    @Override
    public String getName() {
        return "hub-module-server";
    }

    @Override
    public String getHelp() {
        return "Generates Express server bindings for a ZeroBias Module";
    }

    @Override
    public void processOpts() {
        super.processOpts();
        supportingFiles.clear();
        supportingFiles.add(new SupportingFile("api-all.mustache", apiPackage().replace('.', File.separatorChar), "index.ts"));
        if (!additionalProperties.containsKey(MODULE_PACKAGE)) {
            throw new IllegalStateException("modulePackage must be provided");
        }
        // For ESM compatibility, relative paths need /index.js extension
        String modulePackage = (String) additionalProperties.get(MODULE_PACKAGE);
        if (modulePackage.startsWith(".")) {
            additionalProperties.put(MODULE_PACKAGE, modulePackage + "/index.js");
        }
    }

    @Override
    public String toApiFilename(String name) {
        return super.toApiFilename(name) + "Controller";
    }
}
