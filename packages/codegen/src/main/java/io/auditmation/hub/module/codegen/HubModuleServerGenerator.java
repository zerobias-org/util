package io.auditmation.hub.module.codegen;

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
        return "Generates Express server bindings for a Auditmation Module";
    }

    @Override
    public void processOpts() {
        super.processOpts();
        supportingFiles.clear();
        supportingFiles.add(new SupportingFile("api-all.mustache", apiPackage().replace('.', File.separatorChar), "index.ts"));
        if (!additionalProperties.containsKey(MODULE_PACKAGE)) {
            throw new IllegalStateException("modulePackage must be provided");
        }
    }

    @Override
    public String toApiFilename(String name) {
        return super.toApiFilename(name) + "Controller";
    }
}
