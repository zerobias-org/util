package io.zerobias.hub.module.codegen;

import static org.openapitools.codegen.utils.StringUtils.camelize;

import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.common.base.Joiner;
import com.google.common.base.Strings;
import com.google.common.collect.ImmutableMap;
import com.google.common.collect.ImmutableSet;
import com.google.common.collect.Lists;
import org.apache.commons.lang3.tuple.ImmutablePair;
import org.apache.commons.lang3.tuple.Pair;
import org.openapitools.codegen.CodegenComposedSchemas;
import org.openapitools.codegen.CodegenConstants;
import org.openapitools.codegen.CodegenModel;
import org.openapitools.codegen.CodegenOperation;
import org.openapitools.codegen.CodegenParameter;
import org.openapitools.codegen.CodegenProperty;
import org.openapitools.codegen.CodegenSecurity;
import org.openapitools.codegen.SupportingFile;
import org.openapitools.codegen.languages.AbstractTypeScriptClientCodegen;
import org.openapitools.codegen.utils.ModelUtils;
import org.openapitools.codegen.utils.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.Operation;
import io.swagger.v3.oas.models.media.ArraySchema;
import io.swagger.v3.oas.models.media.Schema;
import io.swagger.v3.oas.models.responses.ApiResponse;

public class HubModuleCodegenGenerator extends AbstractTypeScriptClientCodegen {

    private enum CoreTypeSource {
        CORE(System.getProperty("coreTypesSource", "@zerobias-org/types-core-js")),
        AMAZON(System.getProperty("amazonTypesSource", "@zerobias-org/types-amazon-js")),
        GOOGLE(System.getProperty("googleTypesSource", "@zerobias-org/types-google-js")),
        MICROSOFT(System.getProperty("microsoftTypesSource", "@zerobias-org/types-microsoft-js"));

        private String importSource;

        CoreTypeSource(String importSource) {
            this.importSource = importSource;
        }

        @Override
        public String toString() {
            return this.importSource;
        }
    };

    static class CoreTypeMetadata {
        String type;
        CoreTypeSource source;
        public CoreTypeMetadata(String type, CoreTypeSource source) {
            this.type = type;
            this.source = source;
        }
    }

    private static final Logger LOGGER = LoggerFactory.getLogger(HubModuleCodegenGenerator.class);
    private static final String PAGED_RESULTS = "PagedResults";
    private static final String PAGED_LINK_HEADER = "link";
    private static final String PAGE_SIZE = "pageSize";
    private static final String PAGE_NUMBER = "pageNumber";
    private static final String PAGE_TOKEN = "pageToken";
    private static final String SORT_DIRECTION = "sortDir";
    private static final String SORT_BY = "sortBy";

    private static final String CONNECTION_PROFILE = "ConnectionProfile";
    private static final String DEFAULT_IMPORT_PREFIX = "./";

    public static final String X_INPUT_PIPELINE = "x-input-pipeline";
    public static final String X_INPUT_PIPELINE_REGISTRY = X_INPUT_PIPELINE + "-registry";
    public static final String X_OUTPUT_PIPELINE = "x-output-pipeline";
    public static final String X_OUTPUT_PIPELINE_REGISTRY = X_OUTPUT_PIPELINE + "-registry";
    public static final String X_AUTO_GENERATE = "x-auto-generate";
    public static final String X_JSONATA_FUNCTIONS = "x-jsonata-functions";
    public static final String X_JSONATA_EXPRESSIONS = "x-jsonata-expressions";
    public static final String JSONATA_FUNCTION_IMPLEMENTATION_METHOD_NAME = "methodName";
    public static final String JSONATA_FUNCTION_IMPLEMENTATION_MODULE = "module";
    public static final String REGISTER_JSONATA_FUNCTION_IMPLEMENTATION_ERROR_MESSAGE = "Register Jsonata Function Implementation";
    public static final String REGISTER_JSONATA_FUNCTION_SINATURE_ERROR_MESSAGE = "Register Jsonata Function Signature";
    public static final String REGISTER_JSONATA_FUNCTION_NAME_ERROR_MESSAGE = "Register Jsonata Function Name";
    public static final String REGISTER_JSONATA_FUNCTION_DESCRIPTION_ERROR_MESSAGE = "Register Jsonata Function Description";
    public static final String REGISTER_JSONATA_INLINE_FUNCTION_EXAMPLE =
            "  - name: add\n" +
            "    implementation: (a, b) => a + b\n" +
            "    signature: <nn:n>\n" +
            "    description: Compute the sum of two numbers\n" +
            "  - name: diff\n" +
            "    implementation: (a, b) => a - b\n" +
            "    signature: <nn:n>\n";
    public static final String REGISTER_JSONATA_IMPORT_FUNCTION_EXAMPLE =
            "  - name: add\n" +
            "    implementation: " +
            "       methodName: add\n" +
            "       module: '../../src/MathUtil'" +
            "    signature: <nn:n>\n" +
            "  - name: diff\n" +
            "    implementation: (a, b) => a - b\n" +
            "    signature: <nn:n>\n" +
            "    description: Compute the sum of two numbers\n";
    public static final String REGISTER_JSONATA_IMPORT_EXPRESSION_EXAMPLE = "  myJsonataImportedExpression:\n" +
            "    description: my first description\n" +
            "    expressionName: myJsoanataExpressionName\n" +
            "    module: '../../src/PipelineUtil'";
    public static final String REGISTER_JSONATA_INLINE_EXPRESSION_EXAMPLE = "  myJsonataInlinedExpression:\n" +
            "    description: my jsonata expression description\n" +
            "    expression: '|$.location|{\"protocol\": \"https\"}|'";
    public static final String JSONATA_EXPRESSION_NAME = "expressionName";
    public static final String JSONATA_EXPRESSION_MODULE = "module";
    public static final String JSONATA_EXPRESSION_DESCRIPTION = "description";
    public static final String JSONATA_EXPRESSION_INLINED = "expression";
    public static final String IMPORTED = "imported";
    public static final String INLINED = "inlined";
    public static final String EXPRESSION_ALIAS = "expressionAlias";
    public static final String JSONATA_EXPRESSION_REF_NAME = "refName";
    public static final String JSONATA_EXPRESSION_VAR = "expressionVar";

    SimpleDateFormat DATE_FORMAT = new SimpleDateFormat("yyyy-MM-dd");
    DateTimeFormatter DATE_TIME_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'");

    public static final Map<String, CoreTypeMetadata> CORE_TYPES = new HashMap<>();
    public static final Map<String, CoreTypeMetadata> CORE_TYPES_MAP = new HashMap<>();
    private static final String JSONATA = "jsonata";
    private static final String NATIVE = "native";
    private static final Set<String> SUPPORTED_FUNCTION_PARAMETER_TYPES = new HashSet<>();
    public static final String REGISTER_FUNCTION_NAME = "methodName";
    public static final String REGISTER_FUNCTION_MODULE = "module";
    public static final String REGISTER_FUNCTION_PARAMETERS = "parameters";
    public static final String REGISTER_PARAMETER_NAME = "name";
    public static final String REGISTER_PARAMETER_TYPE = "type";
    public static final String JSONATA_FUNCTION_NAME = "name";
    public static final String JSONATA_FUNCTION_IMPLEMENTATION = "implementation";
    public static final String JSONATA_FUNCTION_SIGNATURE = "signature";
    public static final String JSONATA_FUNCTION_DESCRIPTION = "description";

    static {
        // AWS types
        CORE_TYPES_MAP.put("arn", new CoreTypeMetadata("Arn", CoreTypeSource.AMAZON));
        CORE_TYPES_MAP.put("awsPartition", new CoreTypeMetadata("AwsPartition", CoreTypeSource.AMAZON));
        CORE_TYPES_MAP.put("awsService", new CoreTypeMetadata("AwsService", CoreTypeSource.AMAZON));
        CORE_TYPES_MAP.put("awsImageId", new CoreTypeMetadata("AwsImageId", CoreTypeSource.AMAZON));
        CORE_TYPES_MAP.put("awsAccessPolicy", new CoreTypeMetadata("AwsAccessPolicy", CoreTypeSource.AMAZON));
        CORE_TYPES_MAP.put("awsAccessPolicyStatement", new CoreTypeMetadata("AwsAccessPolicyStatement", CoreTypeSource.AMAZON));
        CORE_TYPES_MAP.put("awsAccessPolicyStatementCondition", new CoreTypeMetadata("AwsAccessPolicyStatementCondition", CoreTypeSource.AMAZON));
        CORE_TYPES_MAP.put("awsAccessPolicyStatementEffect", new CoreTypeMetadata("AwsAccessPolicyStatementEffect", CoreTypeSource.AMAZON));
        CORE_TYPES_MAP.put("awsAccessPolicyStatementOperator", new CoreTypeMetadata("AwsAccessPolicyStatementOperator", CoreTypeSource.AMAZON));
        
        // MS types
        CORE_TYPES_MAP.put("azureVmSize", new CoreTypeMetadata("AzureVmSize", CoreTypeSource.MICROSOFT));
        CORE_TYPES_MAP.put("azureResourceProvider", new CoreTypeMetadata("AzureResourceProvider", CoreTypeSource.MICROSOFT));
        CORE_TYPES_MAP.put("azureResource", new CoreTypeMetadata("AzureResource", CoreTypeSource.MICROSOFT));
        CORE_TYPES_MAP.put("azureResourceInfo", new CoreTypeMetadata("AzureResourceInfo", CoreTypeSource.MICROSOFT));
        CORE_TYPES_MAP.put("azureResourceType", new CoreTypeMetadata("AzureResourceType", CoreTypeSource.MICROSOFT));
        CORE_TYPES_MAP.put("azureResourcePlan", new CoreTypeMetadata("AzureResourcePlan", CoreTypeSource.MICROSOFT));
        CORE_TYPES_MAP.put("azureResourceSku", new CoreTypeMetadata("AzureResourceSku", CoreTypeSource.MICROSOFT));
        CORE_TYPES_MAP.put("azureResourceSkuTier", new CoreTypeMetadata("AzureResourceSkuTier", CoreTypeSource.MICROSOFT));
        CORE_TYPES_MAP.put("azureResourceIdentity", new CoreTypeMetadata("AzureResourceIdentity", CoreTypeSource.MICROSOFT));
        CORE_TYPES_MAP.put("azureResourceIdentityType", new CoreTypeMetadata("AzureResourceIdentityType", CoreTypeSource.MICROSOFT));

        // Google types
        CORE_TYPES_MAP.put("gcpAccessPolicy", new CoreTypeMetadata("GcpAccessPolicy", CoreTypeSource.GOOGLE));
        CORE_TYPES_MAP.put("gcpAccessPolicyAuditConfig", new CoreTypeMetadata("GcpAccessPolicyAuditConfig", CoreTypeSource.GOOGLE));
        CORE_TYPES_MAP.put("gcpAccessPolicyAuditLogConfig", new CoreTypeMetadata("GcpAccessPolicyAuditLogConfig", CoreTypeSource.GOOGLE));
        CORE_TYPES_MAP.put("gcpAccessPolicyAuditLogConfigType", new CoreTypeMetadata("GcpAccessPolicyAuditLogConfigType", CoreTypeSource.GOOGLE));
        CORE_TYPES_MAP.put("gcpAccessPolicyBinding", new CoreTypeMetadata("GcpAccessPolicyBinding", CoreTypeSource.GOOGLE));
        CORE_TYPES_MAP.put("gcpAccessPolicyBindingCondition", new CoreTypeMetadata("GcpAccessPolicyBindingCondition", CoreTypeSource.GOOGLE));
        CORE_TYPES_MAP.put("gcpAccessPolicyVersion", new CoreTypeMetadata("GcpAccessPolicyVersion", CoreTypeSource.GOOGLE));

        // Core types
        CORE_TYPES_MAP.put("byte", new CoreTypeMetadata("Byte", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("b64", new CoreTypeMetadata("Byte", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("base64", new CoreTypeMetadata("Byte", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("cidr", new CoreTypeMetadata("Cidr", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("date-time", new CoreTypeMetadata("Date", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("time", new CoreTypeMetadata("Date", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("timestamp", new CoreTypeMetadata("Date", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("date", new CoreTypeMetadata("Date", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("double", new CoreTypeMetadata("number", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("duration", new CoreTypeMetadata("Duration", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("email", new CoreTypeMetadata("Email", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("float", new CoreTypeMetadata("number", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("hostname", new CoreTypeMetadata("Hostname", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("int32", new CoreTypeMetadata("number", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("int64", new CoreTypeMetadata("number", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("integer", new CoreTypeMetadata("number", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("ipAddress", new CoreTypeMetadata("IpAddress", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("ip", new CoreTypeMetadata("IpAddress", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("ipv4", new CoreTypeMetadata("IpAddress", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("ipv6", new CoreTypeMetadata("IpAddress", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("mac", new CoreTypeMetadata("MacAddress", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("macaddr", new CoreTypeMetadata("MacAddress", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("macAddress", new CoreTypeMetadata("MacAddress", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("mimeType", new CoreTypeMetadata("MimeType", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("nmtoken", new CoreTypeMetadata("Nmtoken", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("password", new CoreTypeMetadata("string", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("phoneNumber", new CoreTypeMetadata("PhoneNumber", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("phone", new CoreTypeMetadata("PhoneNumber", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("semver", new CoreTypeMetadata("Semver", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("url", new CoreTypeMetadata("URL", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("uri", new CoreTypeMetadata("URL", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("uuid", new CoreTypeMetadata("UUID", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("oid", new CoreTypeMetadata("OID", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("versionRange", new CoreTypeMetadata("VersionRange", CoreTypeSource.CORE));

        // add these for advanced enum support
        CORE_TYPES_MAP.put("EnumValue", new CoreTypeMetadata("EnumValue", CoreTypeSource.CORE));
        CORE_TYPES_MAP.put("IllegalArgumentError", new CoreTypeMetadata("IllegalArgumentError", CoreTypeSource.CORE));

        CORE_TYPES_MAP.values()
            .forEach((meta) -> {
                if (!CORE_TYPES.containsKey(meta.type)) {
                    CORE_TYPES.put(meta.type, meta);
                }
            });

        SUPPORTED_FUNCTION_PARAMETER_TYPES.add("string");
        SUPPORTED_FUNCTION_PARAMETER_TYPES.add("number");
        SUPPORTED_FUNCTION_PARAMETER_TYPES.add("boolean");
        SUPPORTED_FUNCTION_PARAMETER_TYPES.addAll(CORE_TYPES_MAP.keySet());
    }

    private String apiName;
    private boolean isAutoGenerate;
    private Map<String, List<Map<String, Object>>> jsonataFunctions;
    private Map<String, List<Map<String, Object>>> jsonataExpressions;
    private Map<String, Map<String, Object>> outputNativeFunctions;
    private Map<String, Map<String, Object>> inputNativeFunctions;
    private boolean usesJsonata = false;
    private boolean hasInvoker = false;
    private List<Map<String, Object>> globalInputPipeline = new ArrayList<>();
    private List<Map<String, Object>> globalOutputPipeline = new ArrayList<>();
    private Set<String> enumTypes = new HashSet<>();

    public HubModuleCodegenGenerator() {
        super();

        // RequestFile is defined as: `type RequestFile = string | Buffer | stream.Readable | RequestDetailedFile;`
        typeMapping.put("file", "RequestFile");
        languageSpecificPrimitives.add("Buffer");
        languageSpecificPrimitives.add("Readable");
        languageSpecificPrimitives.add("RequestDetailedFile");
        languageSpecificPrimitives.add("RequestFile");

        languageGenericTypes.add("PagedResults");
        languageGenericTypes.add("Set");

        typeMapping.remove("UUID");
        typeMapping.remove("URI");

        languageSpecificPrimitives.add("Set");
        typeMapping.put("Set", "Set");
        typeMapping.put("set", "Set");

        // clear import mapping (from default generator) as TS does not use it
        // at the moment
        importMapping.clear();

        outputFolder = "generated-code/hub-module";
        embeddedTemplateDir = templateDir = "hub-module";
        modelTemplateFiles.put("model.mustache", ".ts");
        apiTemplateFiles.put("api-single.mustache", ".ts");
        modelPackage = "model";
        apiPackage = "api";

        supportModelPropertyNaming(CodegenConstants.MODEL_PROPERTY_NAMING_TYPE.camelCase);
        setSortModelPropertiesByRequiredFlag(Boolean.TRUE);

        apiNameSuffix = "Api";

        LOGGER.debug("{}", System.getProperties());
    }

    @Override
    public String getName() {
        return "hub-module";
    }

    @Override
    public String getHelp() {
        return "Generates a ZeroBias Hub Module";
    }

    @Override
    public boolean isDataTypeFile(final String dataType) {
        return dataType != null && dataType.equals("RequestFile");
    }

    @Override
    @SuppressWarnings("rawtypes")
    public String getTypeDeclaration(Schema p) {
        if (CORE_TYPES_MAP.containsKey(p.getFormat())) {
            return CORE_TYPES_MAP.get(p.getFormat()).type;
        }
        if (ModelUtils.isFileSchema(p)) {
            return "RequestFile";
        } 
        if (ModelUtils.isBinarySchema(p)) {
            return "Buffer";
        }
        return super.getTypeDeclaration(p);
    }

    @Override
    @SuppressWarnings("rawtypes")
    protected void handleMethodResponse(Operation operation, Map<String, Schema> schemas, CodegenOperation op,
                                        ApiResponse methodResponse) {
        handleMethodResponse(operation, schemas, op, methodResponse, Collections.<String, String>emptyMap());
    }

    @Override
    public String toApiFilename(String name) {
        if (name.length() == 0) {
            return "default";
        }
        if (importMapping.containsKey(name)) {
            return importMapping.get(name);
        }
        return toApiName(name);
    }

    @Override
    public String toApiImport(String name) {
        if (importMapping.containsKey(name)) {
            return importMapping.get(name);
        }

        return apiPackage() + "/" + toApiFilename(name);
    }

    @Override
    public String toModelFilename(String name) {
        if (importMapping.containsKey(name)) {
            return importMapping.get(name);
        }

        return DEFAULT_IMPORT_PREFIX + camelize(toModelName(name));
    }

    @Override
    public String toModelName(final String name) {
        if (CONNECTION_PROFILE.equals(name) || CORE_TYPES.containsKey(name)) {
            return name;
        }
        if ((!Strings.isNullOrEmpty(getModelNamePrefix()) && name.startsWith(getModelNamePrefix()))
                || (!Strings.isNullOrEmpty(getModelNameSuffix()) && name.endsWith(getModelNameSuffix()))) {
            // already been through here...
            return name;
        }
        return super.toModelName(name);
    }

    @Override
    public String toModelImport(String name) {
        if (importMapping.containsKey(name)) {
            return importMapping.get(name);
        }

        return modelPackage() + "/" + camelize(name);
    }

    @Override
    public String toDefaultValue(Schema p) {
        if (p.getDefault() == null || !CORE_TYPES_MAP.containsKey(p.getFormat())) {
            return super.toDefaultValue(p);
        }

        if (CORE_TYPES_MAP.get(p.getFormat()).type.equals("Date")
                || CORE_TYPES_MAP.get(p.getFormat()).type.equals("number")) {
            return super.toDefaultValue(p);
        }

        boolean isStringSchema = ModelUtils.isStringSchema(p);
        String constructorParam = null;
        if (ModelUtils.isDateSchema(p)) {
            constructorParam = DATE_FORMAT.format((Date) p.getDefault());
        } else if (ModelUtils.isDateTimeSchema(p)) {
            constructorParam = DATE_TIME_FORMAT.format((OffsetDateTime) p.getDefault());
        } else if (ModelUtils.isUUIDSchema(p) || ModelUtils.isURISchema(p)) {
            constructorParam = p.getDefault().toString();
        } else if (ModelUtils.isURISchema(p)) {
            constructorParam = p.getDefault().toString();
        }

        return "new " +
                CORE_TYPES_MAP.get(p.getFormat()).type +
                "(" +
                (isStringSchema ? "'" : "") +
                (constructorParam != null ? constructorParam : p.getDefault()) +
                (isStringSchema ? "'" : "") +
                ")";
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> postProcessAllModels(Map<String, Object> objs) {
        Map<String, Object> result = super.postProcessAllModels(objs);
        Iterator<Map.Entry<String, Object>> iter = result.entrySet().iterator();

        // first, look for all enums that are externally defined
        while (iter.hasNext()) {
            Map.Entry<String, Object> entry = iter.next();
            Map<String, Object> inner = (Map<String, Object>) entry.getValue();
            List<Map<String, Object>> models = (List<Map<String, Object>>) inner.get("models");
            for (Map<String, Object> mo : models) {
                CodegenModel cm = (CodegenModel) mo.get("model");
                if (cm.isEnum) {
                    LOGGER.info("Detected {} as enum", cm.classname);
                    this.enumTypes.add(cm.classname);
                }
            }
        }

        iter = result.entrySet().iterator();
        while (iter.hasNext()) {

            Map.Entry<String, Object> entry = iter.next();
            String key = entry.getKey();

            // don't generate class for PagedResults or its ilk
            if (key.equals(PAGED_RESULTS) ||
                    key.contains(PAGED_RESULTS + "_allOf")) {
                LOGGER.info("Removing model {} from generation", key);
                iter.remove();
                continue;
            }

            LOGGER.info("Post-processing model {}", key);

            Map<String, Object> inner = (Map<String, Object>) entry.getValue();
            List<Map<String, Object>> models = (List<Map<String, Object>>) inner.get("models");

            /*
             * The basic shape a PagedResults collection will take is a FooPagedResults comprised
             * of two interfaces: one with the array of items, one being our actual PagedResults
             */
            CodegenModel model = (CodegenModel) models.get(0).get("model");
            List<CodegenModel> ifaceModels = model.getInterfaceModels();
            if (ifaceModels != null) {
                for (CodegenModel ifaceModel : ifaceModels) {
                    if (ifaceModel.getName().equals(PAGED_RESULTS)) {
                        throw new IllegalStateException("Hub Module APIs must not explicitly define PagedResults types");
                    }
                }
            }

            for (Map<String, Object> mo : models) {
                CodegenModel cm = (CodegenModel) mo.get("model");
                Set<String> imports = new HashSet<>();
                cm.getVars()
                    .forEach((cp) -> {
                        processEnum(cp, imports, cm.getClassname());
                    });
                CodegenModel loopModel = cm;
                List<CodegenProperty> parentVars = new ArrayList<>();
                imports.addAll(cm.getImports());
                if (cm.isEnum || cm.hasEnums) {
                    imports.add("EnumValue");
                    imports.add("IllegalArgumentError");
                    List<Map<String, Object>> enumVars;
                    if (cm.isEnum) {
                        enumVars = ((ArrayList<Map<String, Object>>)cm.allowableValues.get("enumVars"));
                        for (Map<String, Object> o : enumVars) {
                            o.put("escapedEnumDescription", escapeText((String)o.get("enumDescription")));
                        }
                    } else {
                        for (CodegenProperty var : cm.vars) {
                            if (var.isEnum) {
                                enumVars = ((ArrayList<Map<String, Object>>)var.allowableValues.get("enumVars"));
                                for (Map<String, Object> o : enumVars) {
                                    o.put("escapedEnumDescription", escapeText((String)o.get("enumDescription")));
                                }
                            }
                            
                        }
                    }
                }
                while (loopModel.getParent() != null && loopModel.getParentModel() != null) {
                    loopModel = loopModel.getParentModel();
                    imports.addAll(loopModel.getImports());
                    parentVars = Stream.of(loopModel.getVars(), parentVars)
                            .flatMap(Collection::stream)
                            .collect(Collectors.toList());
                }

                LOGGER.info("Checking parent vars for enums {}", parentVars);
                parentVars.forEach((cp) -> processEnum(cp, imports, cm.getClassname()));
                cm.setImports(imports);
                cm.setParentVars(parentVars);

                // Add additional filename information for imports
                mo.put("tsImports", toTsImports(cm, cm.imports));
                mo.put("b64Schema", Base64.getEncoder().encodeToString(cm.modelJson.getBytes()));
            }
        }
        return result;
    }

    private void processEnum(CodegenProperty cp, Set<String> imports, String namespace) {
        LOGGER.info("Checking if {} is an enum...", cp.dataType);
        if (this.enumTypes.contains(cp.dataType)) {
            LOGGER.info("parent {} is an enum...changing to {}Def", cp.dataType, cp.dataType);
            if (!cp.getDatatypeWithEnum().equals(cp.getDataType() + "Def")) {
                cp.setDatatypeWithEnum(cp.getDataType() + "Def");
            }
            imports.add(cp.getDatatypeWithEnum());
        }

        // inline enums
        if (cp.isEnum) {
            LOGGER.debug("Inline enum {} - {}", cp.getDataType(), cp.enumName);
            String enumName = (namespace != null ? namespace + "." : "") + cp.enumName;
            if (!Objects.equals(cp.dataType + "Def", cp.datatypeWithEnum)
                    || !Objects.equals(cp.dataType, enumName)) {
                cp.dataType = enumName;
                cp.datatypeWithEnum = enumName + "Def";
            }
        }

        // arrays of enums
        if (cp.isArray) {
            LOGGER.debug("Hey! An Array! {}, {}:\n{}\n{}\n", cp.dataType, cp.datatypeWithEnum, cp.items, cp);
            processEnum(cp.items, imports, namespace);
            cp.dataType = "Array<" + cp.items.dataType + ">";
            cp.datatypeWithEnum = "Array<" + cp.items.datatypeWithEnum + ">";
            if (cp.vendorExtensions == null) {
                cp.vendorExtensions = new HashMap<>();
            }
            cp.vendorExtensions.put("enumTypeName", cp.items.dataType);
            cp.vendorExtensions.put("enumTypeDef", cp.items.datatypeWithEnum);
        }

        if(cp.isMap && cp.items != null) {
          boolean isEnumRefedMap = false;
          boolean isInline = cp.items.isEnum;
          if(cp.items.allowableValues != null) { // Refed enums for some reason endup with isMap=true and isEnum=false
            ArrayList<String> enumVars = (ArrayList<String>) cp.items.allowableValues.get("enumVars");
            LOGGER.debug("Hey! Is this a refed Enum Map! {}, {}:\n{}:\n{}", cp.dataType, cp.datatypeWithEnum, cp.items, enumVars);
            isEnumRefedMap = enumVars != null && enumVars.size() > 0;
          }
          if(isInline || isEnumRefedMap) {
            LOGGER.debug("Hey! A Map! {}, {}:\n{}", cp.dataType, cp.datatypeWithEnum, cp.items);
            processEnum(cp.items, imports, namespace);
            String enumName = isInline ? namespace + "." + cp.enumName : cp.items.dataType;
            cp.dataType = "{ [key: string]: " + enumName + "; }";
            cp.datatypeWithEnum = "{ [key: string]: " + enumName + "Def; }";
            if (cp.vendorExtensions == null) {
                cp.vendorExtensions = new HashMap<>();
            }
            cp.vendorExtensions.put("enumTypeName", enumName);
            cp.vendorExtensions.put("enumTypeDef", enumName + "Def");
          }
        }

        CodegenComposedSchemas composed = cp.getComposedSchemas();
        if (composed != null) {
            LOGGER.debug("{} has composed schemas: {}", cp.dataType, composed);
            List<String> dataTypes = new ArrayList<>();
            List<String> dataTypesWithEnum = new ArrayList<>();
            List<CodegenProperty> toProcess = Collections.emptyList();
            String delimiter = " | ";
            if (composed.getAllOf() != null) {
                toProcess = composed.getAllOf();
                delimiter = " & ";
            } else if (composed.getAnyOf() != null) {
                toProcess = composed.getAnyOf();
            } else if (composed.getOneOf() != null) {
                toProcess = composed.getOneOf();
            }
            toProcess.forEach((prop) -> {
                processEnum(prop, imports, namespace);
                dataTypes.add(prop.dataType);
                dataTypesWithEnum.add(prop.datatypeWithEnum);
            });
            cp.dataType = String.join(delimiter, dataTypes);
            cp.datatypeWithEnum = String.join(delimiter, dataTypesWithEnum);
        }
    }

    private List<Map<String, String>> toTsImports(CodegenModel cm, Set<String> imports) {
        List<Map<String, String>> tsImports = new ArrayList<>();
        Map<String, Set<String>> typesImports = new HashMap<>();
        for (String im : imports) {
            if (cm == null || !im.equals(cm.classname)) {
                LOGGER.info("Looking for import {}", im);
                CoreTypeMetadata meta = CORE_TYPES.get(im);
                if (meta != null) {
                    Set<String> types = typesImports.get(meta.source.toString());
                    if (types == null) {
                        types = new HashSet<>();
                        typesImports.put(meta.source.toString(), types);
                    }
                    types.add(meta.type);
                } else {
                    HashMap<String, String> tsImport = new HashMap<>();
                    tsImport.put("classname", im);
                    String noDef = im.substring(0, im.length() - 3);
                    if (this.enumTypes.contains(noDef)) {
                        tsImport.put("filename", toModelFilename(noDef) + ".js");
                    } else {
                        tsImport.put("filename", toModelFilename(im) + ".js");
                    }
                    tsImports.add(tsImport);
                }
            }
        }

        for (Map.Entry<String, Set<String>> entry : typesImports.entrySet()) {
            LOGGER.info("Import mapping for {}", entry.getKey());
            Map<String, String> im = new HashMap<>();
            im.put("classname", Joiner.on(", ").join(entry.getValue()));
            // For ESM compatibility, relative paths need /index.js extension
            String importPath = entry.getKey();
            if (importPath.startsWith(".")) {
                importPath = importPath + "/index.js";
            }
            im.put("filename", importPath);
            tsImports.add(im);
        }
        return tsImports;
    }

    private String toApiBaseName(String name) {
        String stripped = name;
        String pre = getApiNamePrefix();
        if (!Strings.isNullOrEmpty(pre) && name.startsWith(pre)) {
            stripped = stripped.substring(pre.length());
        }
        String suf = getApiNameSuffix();
        if (!Strings.isNullOrEmpty(suf) && name.endsWith(suf)) {
            stripped = stripped.substring(0, stripped.length() - suf.length());
        }
        LOGGER.debug("Got API base name of {} from {}", stripped, name);
        return stripped;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> postProcessOperationsWithModels(Map<String, Object> operations, List<Object> allModels) {

        operations.put("apiName", this.apiName);

        Map<String, Object> objs = (Map<String, Object>) operations.get("operations");

        ImmutableMap.Builder<String, CodegenModel> builder = ImmutableMap.builder();
        for (Object o : allModels) {
            CodegenModel model = (CodegenModel) ((Map<String, Object>) o).get("model");
            builder.put(model.classname, model);
        }

        // The api.mustache template requires all of the auth methods for the whole api
        // Loop over all the operations and pick out each unique auth method
        Map<String, CodegenSecurity> authMethodsMap = new HashMap<>();
        List<CodegenOperation> ops = (List<CodegenOperation>) objs.get("operation");
        boolean hasInvoker = false;
        boolean hasProducer = false;
        Map<String, Map<String, String>> nativeImports = new HashMap<>();
        Map<String, CodegenParameter> apiInlineEnums = new HashMap<>();

        StringBuilder coreTypesBuilder = new StringBuilder();
        coreTypesBuilder.append("URL, EnumValue, IllegalArgumentError, PagedResults, ");
        for (CodegenOperation op : ops) {

            LOGGER.info("Operation {} returns {} (base={}, container={}, simple={}, hasQueryParams={}, hasResponseHeaders={})", 
                    op.operationId, op.returnType, op.returnBaseType, op.returnContainer, 
                    op.returnSimpleType, op.getHasQueryParams(), op.getHasResponseHeaders());

            boolean plaintext = false;
            if (op.produces != null) {
                for (Map<String, String> produces : op.produces) {
                    String mt = produces.get("mediaType");
                    if (mt != null && "text/plain".equals(mt)) {
                        plaintext = true;
                        break;
                    }
                }
            }

            op.vendorExtensions.put("x-produces-plaintext", plaintext);
            op.vendorExtensions.put("x-lower-http-method", op.httpMethod.toLowerCase());
            op.vendorExtensions.put("x-titlecase-http-method", op.httpMethod.substring(0, 1).toUpperCase() + op.httpMethod.substring(1).toLowerCase());

            // Add useSpecHttpMethods flag support for API clients
            boolean useSpecHttpMethods = Boolean.parseBoolean((String) additionalProperties.get("useSpecHttpMethods"));
            op.vendorExtensions.put("x-use-spec-http-methods", useSpecHttpMethods);

            // Add flag to identify GET methods for proper parameter handling
            if (useSpecHttpMethods && "GET".equals(op.httpMethod)) {
                op.vendorExtensions.put("x-is-get-method", true);
            }

            // Add flag to identify DELETE methods for proper parameter handling
            // DELETE methods, like GET, cannot have request bodies in Axios
            if (useSpecHttpMethods && "DELETE".equals(op.httpMethod)) {
                op.vendorExtensions.put("x-is-delete-method", true);
            }

            // Add flag when operation has single body parameter (needs spreading)
            // When requestBody has a schema reference, OpenAPI Generator creates a single parameter
            // We need to spread it: { ...param } instead of { param }
            // This applies regardless of path params count (e.g., PUT /resource/{id} with body)
            if (useSpecHttpMethods && op.bodyParams.size() == 1) {
                op.vendorExtensions.put("x-single-body-param", true);
            }

            if (op.vendorExtensions.containsKey("x-method-name")) {
                op.nickname = (String) op.vendorExtensions.get("x-method-name");
            }

            if (op.hasAuthMethods) {
                for (CodegenSecurity sec : op.authMethods) {
                    authMethodsMap.put(sec.name, sec);
                }
            }

            boolean includeJsonata = !(op.formParams.stream().anyMatch((formParam) -> formParam.isBinary)
                    || op.isResponseBinary);
            Pair<Boolean, Map<String, Map<String, String>>> inputPipelineInfo = regroupPipelineFunctions(
                    X_INPUT_PIPELINE, 
                    this.globalInputPipeline,
                    this.inputNativeFunctions,
                    op,
                    includeJsonata);
            Pair<Boolean, Map<String, Map<String, String>>> outputPipelineInfo = regroupPipelineFunctions(
                    X_OUTPUT_PIPELINE,
                    this.globalOutputPipeline,
                    this.outputNativeFunctions,
                    op,
                    includeJsonata);

            usesJsonata = usesJsonata || inputPipelineInfo.getLeft() || outputPipelineInfo.getLeft();
            nativeImports.putAll(inputPipelineInfo.getRight());
            nativeImports.putAll(outputPipelineInfo.getRight());

            Boolean opAutoGenerate = (Boolean) op.vendorExtensions.get(X_AUTO_GENERATE);
            boolean shouldAutoGenerate = isAutoGenerate
                    ? !Boolean.FALSE.equals(opAutoGenerate)
                    : Boolean.TRUE.equals(opAutoGenerate);
            op.vendorExtensions.put(X_AUTO_GENERATE, shouldAutoGenerate);
            if (shouldAutoGenerate) {
                hasInvoker = true;
            } else {
                hasProducer = true;
            }

            if (isPaginated(op)) {
                LOGGER.info("Transforming from {} to PagedResults", op.returnType);
                op.returnContainer = PAGED_RESULTS;
                op.returnType = PAGED_RESULTS + "<" + op.returnBaseType + ">";
                if (hasSortParams(op)) {
                    op.vendorExtensions.put("x-has-sort", true);
                }
            } else {
                LOGGER.info("Not Transforming from {} to PagedResults.", op.returnType);
            }

            List<CodegenParameter> allActualParams = new ArrayList<>();
            allActualParams.addAll(op.allParams);
            allActualParams.addAll(op.queryParams);
            allActualParams.addAll(op.pathParams);

            if (op.returnType != null && op.returnType.startsWith(PAGED_RESULTS)) {
                op.vendorExtensions.put("x-returns-paged-results", true);
                LOGGER.debug("{} returning PagedResults", op.operationId);
                for (CodegenParameter param : allActualParams) {
                    if (param.baseName.equalsIgnoreCase(PAGE_SIZE) 
                            || param.baseName.equalsIgnoreCase(PAGE_NUMBER)
                            || param.baseName.equalsIgnoreCase(PAGE_TOKEN)) {
                        param.vendorExtensions.put("x-producer-omit", true);
                        param.vendorExtensions.put("x-pagination-param", true);
                    }
                    if (param.baseName.equalsIgnoreCase(PAGE_NUMBER)) {
                        op.vendorExtensions.put("x-pagination-include-page-number", true);
                    }
                    if (param.baseName.equalsIgnoreCase(PAGE_TOKEN)) {
                        op.vendorExtensions.put("x-pagination-include-page-token", true);
                    }
                    if (param.baseName.equalsIgnoreCase(SORT_BY)
                            || param.baseName.equalsIgnoreCase(SORT_DIRECTION)) {
                        param.vendorExtensions.put("x-producer-omit", true);
                    }
                }
            }

            Set<String> enumNames = new HashSet<>();
            Set<CodegenParameter> enums = (Set<CodegenParameter>) operations.get("enums");
            if (enums == null) {
                enums = new HashSet<>();
                LOGGER.debug("=== creating enum array for ");
                operations.put("enums", enums);
            }
            for (CodegenParameter param : allActualParams) {
                LOGGER.debug("{} {} {}", param.paramName, param.isNumeric, param.defaultValue);
                if (param.isArray && "undefined".equals(param.defaultValue)) {
                    param.defaultValue = param.required ? "[]" : null;
                }
                if (param.isMap && "undefined".equals(param.defaultValue)) {
                    param.defaultValue = param.required ? "{}" : null;
                }

                if ("undefined".equals(param.defaultValue)) {
                    param.defaultValue = null;
                }

                if (param.dataType.equalsIgnoreCase("number") 
                        && (param.dataFormat != null && param.dataFormat.toLowerCase() != "password")
                        || param.isInteger) {
                    String validator;
                    try {
                        validator = StringUtils.camelize(
                                param.dataFormat != null
                                        ? param.dataFormat
                                        : new ObjectMapper().readTree(param.jsonSchema)
                                        .get("schema")
                                        .get("type")
                                        .asText()
                        );
                        param.vendorExtensions.put("x-validate-with", validator);
                        if (!coreTypesBuilder.toString().contains(validator)) {
                            coreTypesBuilder.append(validator).append(", ");
                        }
                    } catch (JsonProcessingException e) {
                        throw new RuntimeException(e);
                    }
                }

                if (param.isString && !param.isEnum &&
                        !param.dataType.equalsIgnoreCase("string")) {
                    param.isString = false;
                    if (param.defaultValue != null) {
                        param.defaultValue =
                                "new " +
                                        typeMapping.get(param.dataFormat) +
                                        "(" + param.defaultValue + ")";
                    }
                }
                if (param.getSchema() != null) {
                    processEnum(param.getSchema(), new HashSet<String>(), (String) objs.get("classname"));
                    param.dataType = param.getSchema().dataType;
                    param.datatypeWithEnum = param.getSchema().datatypeWithEnum;
                }

                if (param.datatypeWithEnum == null) {
                    param.datatypeWithEnum = param.dataType;
                }

                if (param.isEnum) {
                    LOGGER.debug("*** Operation {} has enum {} defaultValue={}",
                            op.operationId, param.enumName, param.defaultValue);
                    if (!enumNames.contains(param.enumName)) {
                        enums.add(param);
                        enumNames.add(param.enumName);
                        apiInlineEnums.put(param.enumName, param);
                    }
                    if (!Strings.isNullOrEmpty(param.defaultValue)) {
                        param.defaultValue = param.dataType + "." + toEnumVarName(param.defaultValue.replaceAll("'", ""), "string") + " as " + param.datatypeWithEnum;
                    }
                }
            }
            if (this.enumTypes.contains(op.returnType)) {
                LOGGER.debug("*** Operation {} returns an enum type - switching to {}Def",
                        op.operationId, op.returnType);
                op.returnType = op.returnType + "Def";
            }
            if (op.returnType != null && op.returnType.startsWith("any")) {
                op.vendorExtensions.put("x-returns-any", true);
            }
            op.vendorExtensions.put("x-returns-file", "RequestFile".equals(op.returnType));
        }
        operations.put("usesJsonata", usesJsonata);
        operations.put("inlineEnums", apiInlineEnums.values());
        this.hasInvoker = this.hasInvoker || hasInvoker;

        if (hasInvoker) {
            operations.put("invokerName", objs.get("classname") + "InvokerImpl");
            operations.put("pipelineMethodImports", nativeImports.values());
            if (hasProducer) {
                operations.put("customProducer", true);
            }
        }

        operations.put("producerName", toApiName(toApiBaseName((String) objs.get("classname")) + "Producer"));

        // If there wer any auth methods specified add them to the operations context
        if (!authMethodsMap.isEmpty()) {
            operations.put("authMethods", authMethodsMap.values());
            operations.put("hasAuthMethods", true);
        }

        // Add filename information for api imports
        objs.put("apiFilename", getApiFilenameFromClassname(objs.get("classname").toString()));

        // Add additional filename information for model imports in the apis
        List<Map<String, Object>> imports = (List<Map<String, Object>>) operations.get("imports");
        Iterator<Map<String, Object>> iter = imports.iterator();
        StringBuilder modelImportsBuilder = new StringBuilder();
        Map<String, Set<String>> tsImports = new HashMap<>();
        LOGGER.debug("Unrolling imports");
        while (iter.hasNext()) {
            Map<String, Object> im = iter.next();
            LOGGER.debug("{}", im);
            String classname = getModelnameFromModelFilename(im.get("import").toString());
            CoreTypeMetadata meta = CORE_TYPES.get(classname);
            if (meta != null) {
                if (CoreTypeSource.CORE == meta.source) {
                    if (!coreTypesBuilder.toString().contains(classname)) {
                        coreTypesBuilder.append(classname).append(", ");
                    }       
                } else {
                    Set<String> types = tsImports.get(meta.source.toString());
                    if (types == null) {
                        types = new HashSet<>();
                        tsImports.put(meta.source.toString(), types);
                    }
                    types.add(meta.type);
                }
            } else if (needToImport(classname.toLowerCase())) {
                if (this.enumTypes.contains(classname)) {
                    modelImportsBuilder.append(classname + "Def").append(", ");
                } else {
                    modelImportsBuilder.append(classname).append(", ");
                }
            }
            iter.remove();
        }
        String ctImport = coreTypesBuilder.toString();
        if (ctImport.length() > 0) {
            operations.put("coreTypes", ctImport);
        }

        String modelImports = modelImportsBuilder.toString();
        if (modelImports.length() > 0) {
            Map<String, Object> im = new HashMap<>();
            im.put("filename", modelPackage());
            im.put("classname", modelImports.substring(0, modelImports.length() - 2));
            imports.add(im);
        }
        operations.put("tsImports", tsImports
                .entrySet()
                .stream()
                .map((entry) -> {
                    Map<String, String> tsImport = new HashMap<>();
                    tsImport.put("filename", entry.getKey());
                    tsImport.put("classname", Joiner.on(", ").join(entry.getValue()));
                    return tsImport;
                })
                .collect(Collectors.toList()));
        return operations;
    }

    private Map<String, Map<String, Object>> mergeDefaultWithRegisteredNativeFunctions(String registry, Map<String, Map<String, Object>> defaultInputNativeFunctions) {
        if (this.openAPI.getExtensions() == null || !this.openAPI.getExtensions().containsKey(registry)) {
            return new HashMap<>();
        }
        Map<String, Map<String, Object>> registeredInputNativeFunctions = 
            (Map<String, Map<String, Object>>) this.openAPI.getExtensions().get(registry);
        Map<String, Map<String, Object>> inputNativeFunctions = new HashMap<>();
        inputNativeFunctions.putAll(defaultInputNativeFunctions);
        inputNativeFunctions.putAll(registeredInputNativeFunctions);
        return inputNativeFunctions;
    }

    private Pair<Boolean, Map<String, Map<String, String>>> regroupPipelineFunctions(
            String pipelineName,
            List<Map<String, Object>> globalPipeline,
            Map<String, Map<String, Object>> registeredNativeFunctions,
            CodegenOperation op,
            boolean includeJsonata) {
        boolean usesJsonata = false;
        Map<String, Map<String, String>> nativeImports = new HashMap<>();
        List<Map<String, Object>> pipeline;
        try {
            pipeline = (List<Map<String, Object>>) op.vendorExtensions.get(pipelineName);
        } catch (ClassCastException error) {
            throw new RuntimeException(X_INPUT_PIPELINE + " and " + X_OUTPUT_PIPELINE + " should be list of maps; Example:\n" +
                    "      " + X_INPUT_PIPELINE + ":\n" +
                    "        - jsonata: '|$|{\"method\" : \"get\"}|'\n" +
                    "        - updateParameterValue:\n" +
                    "            for: paramName\n" +
                    "            to: paramValue");
        }

        List<Map<String, Object>> newPipeline = Stream.of(
                        globalPipeline,
                        pipeline != null ? pipeline : new ArrayList<>())
                .flatMap(Collection::stream)
                .map((raw) -> processPipelineItem(raw, registeredNativeFunctions, nativeImports, includeJsonata))
                .filter(Optional::isPresent)
                .map(Optional::get)
                .collect(Collectors.toList());

        usesJsonata = newPipeline.stream().anyMatch((obj) -> obj.containsKey(JSONATA) && (Boolean) obj.get(JSONATA));
        op.vendorExtensions.put(pipelineName, newPipeline);
        return new ImmutablePair<>(usesJsonata, nativeImports);
    }

    @SuppressWarnings("unchecked")
    private Optional<Map<String, Object>> processPipelineItem(
            Object rawPipelineItem,
            Map<String, Map<String, Object>> nativeFunctions,
            Map<String, Map<String, String>> nativeImports,
            boolean includeJsonata) {
        Map<String, Object> pipelineItem = rawPipelineItem instanceof String
            ? ImmutableMap.of((String) rawPipelineItem, (Object) new HashMap<>())
            : (Map<String, Object>) rawPipelineItem;
        if (pipelineItem.containsKey(JSONATA) && !includeJsonata) {
            return Optional.empty();
        }

        Map<String, Object> newInputItem = new LinkedHashMap<>();
        if (pipelineItem.containsKey(JSONATA)) {
            if (!(pipelineItem.get(JSONATA) instanceof String)){
                throw new RuntimeException("jsonata pipeline item should be of type string: reference to registered expression or inline declaration");
            }
            String jsonataReferenceOrExpression = (String) pipelineItem.get(JSONATA);

            newInputItem.put(JSONATA, true);
            if (jsonataReferenceOrExpression.startsWith("|") && jsonataReferenceOrExpression.endsWith("|")) {
                newInputItem.put("expression", jsonataReferenceOrExpression);
            } else {
                Optional<Object> expressionAlias = this.jsonataExpressions.getOrDefault(IMPORTED, new ArrayList<>()).stream()
                        .filter(Map.class::isInstance)
                        .filter(expressionMetadata -> expressionMetadata.get(EXPRESSION_ALIAS).equals(jsonataReferenceOrExpression))
                        .map(expressionMetadata -> expressionMetadata.get(EXPRESSION_ALIAS))
                        .findFirst();
                if (expressionAlias.isPresent()) {
                    newInputItem.put(JSONATA_EXPRESSION_VAR, expressionAlias.get());
                } else {
                    Optional<Object> refName = this.jsonataExpressions.getOrDefault(INLINED, new ArrayList<>()).stream()
                            .filter(Map.class::isInstance)
                            .filter(expressionMetadata -> expressionMetadata.get(JSONATA_EXPRESSION_REF_NAME).equals(jsonataReferenceOrExpression))
                            .map(expressionMetadata -> expressionMetadata.get(JSONATA_EXPRESSION_REF_NAME))
                            .findFirst();
                    if (refName.isPresent()) {
                        newInputItem.put(JSONATA_EXPRESSION_VAR, refName.get());
                    } else {
                        throw new RuntimeException("Invalid jsonata expression reference: " + jsonataReferenceOrExpression + ". Insert a valid jsoanta transform expression or reference a registered expression");
                    }
                }
            }

        } else {
            if (pipelineItem.keySet().size() != 1) {
                throw new RuntimeException("Only one method reference expected. Methods referenced: " + pipelineItem.keySet());
            }
            String methodRef = pipelineItem.keySet().iterator().next();

            Map<String, Object> methodMetadata = validatePipelineMethod(nativeFunctions, methodRef, pipelineItem);

            newInputItem.put(NATIVE, true);
            Map<String, Map<String, String>> imports = extractImports(methodMetadata);
            nativeImports.putAll(imports);
            newInputItem.put("methodName", extractMethodName(methodMetadata));
            newInputItem.put("methodParams", extractMethodParams(methodMetadata, (Map<String, String>) pipelineItem.get(methodRef)));
        }
        return Optional.of(newInputItem);
    }

    private Map<String, Object> validatePipelineMethod(Map<String, Map<String, Object>> inputNativeFunctions, String methodRef, Map<String, Object> pipelineItem) {
        Map<String, Object> methodMetadata = inputNativeFunctions.get(methodRef);
        if (methodMetadata == null) {
            throw new RuntimeException(String.format("Method %s not registered", methodRef));
        }

        List<Map<String, String>> parametersMetadata = (List<Map<String, String>>) methodMetadata.get(REGISTER_FUNCTION_PARAMETERS);
        Map<String, String> pipelineFunction;

        try {
            pipelineFunction = (Map<String, String>) pipelineItem.get(methodRef);
        } catch (ClassCastException error) {
            throw new RuntimeException("Body of a referenced method should be a map. Example: " +
                    "        - myReferencedMethod:\n" +
                    "            for: myFirstParam\n" +
                    "            to: mySecondParam");
        }

        if (parametersMetadata != null && parametersMetadata.size() != pipelineFunction.size()) {
            throw new RuntimeException(String.format("Method %s is registered with %s params but %s provided in the pipeline", methodRef, parametersMetadata.size(), pipelineFunction.size()));
        }

        if (parametersMetadata == null && (pipelineFunction != null && !pipelineFunction.isEmpty())) {
            throw new RuntimeException(String.format("Method %s is registered with no params. %s params provided in the pipeline", methodRef, pipelineFunction.size()));
        }

        if (parametersMetadata != null) {
            for (Map<String, String> parameterMetadata : parametersMetadata) {
                if (!pipelineFunction.containsKey(parameterMetadata.get(REGISTER_PARAMETER_NAME))) {
                    throw new RuntimeException(String.format("Method %s is registered with param %s but not provided in the pipeline", methodRef, parameterMetadata.get(REGISTER_PARAMETER_NAME)));
                }
            }

        }
        return methodMetadata;
    }

    private void validateMethodRegistration(Map<String, Map<String, Object>> nativeFunctions) {

        for (Map.Entry<String, Map<String, Object>> refToMethodMetadata : nativeFunctions.entrySet()) {
            String ref = refToMethodMetadata.getKey();
            Map<String, Object> methodMetadata = refToMethodMetadata.getValue();
            if (!methodMetadata.containsKey(REGISTER_FUNCTION_NAME)) {
                throw new RuntimeException(String.format("Registered function %s should specify it's name by 'methodName' attribute", ref));
            }
            if (!methodMetadata.containsKey(REGISTER_FUNCTION_MODULE)) {
                throw new RuntimeException(String.format("Registered function %s should specify it's location by 'module' attribute", ref));
            }

            if (methodMetadata.size() > 3 || methodMetadata.size() == 3 && !methodMetadata.containsKey(REGISTER_FUNCTION_PARAMETERS)) {
                throw new RuntimeException(String.format("Invalid registration of function %s; Expected registration fields are: ; Provided: %s", ref, ImmutableSet.of(REGISTER_FUNCTION_NAME, REGISTER_FUNCTION_MODULE, REGISTER_FUNCTION_PARAMETERS)));
            }

            if (methodMetadata.containsKey(REGISTER_FUNCTION_PARAMETERS)) {
                List<Map<String, String>> parametersMetadata;
                try {
                    parametersMetadata = (List<Map<String, String>>) methodMetadata.get(REGISTER_FUNCTION_PARAMETERS);
                } catch (ClassCastException error) {
                    throw new RuntimeException("Parameters registration should be a list of maps. Example:" +
                            "    parameters:\n" +
                            "      - name: myFirstParam\n" +
                            "        type: string\n" +
                            "      - name: mySecondParam\n" +
                            "        type: string");
                }
                parametersMetadata.forEach(parameterMetadata -> {
                    if (parameterMetadata.size() != 2) {
                        throw new RuntimeException(String.format("Invalid parameter registration for method %s; Expected 'name' and 'type' attributes; Provided %s", ref, parameterMetadata.keySet()));
                    }
                    if (parameterMetadata.get(REGISTER_PARAMETER_NAME) == null) {
                        throw new RuntimeException(String.format("Invalid parameter registration for method %s; 'name' attribute expected", ref));
                    } else if (!(parameterMetadata.get(REGISTER_PARAMETER_NAME) instanceof String)) {
                        throw new RuntimeException(String.format("Invalid parameter registration for method %s; 'name' should be of type string", ref));
                    }
                    if (parameterMetadata.get(REGISTER_PARAMETER_TYPE) == null) {
                        throw new RuntimeException(String.format("Invalid parameter registration for method %s; 'type' attribute expected", ref));
                    } else if (!(parameterMetadata.get(REGISTER_PARAMETER_TYPE) instanceof String)) {
                        throw new RuntimeException(String.format("Invalid parameter registration for method %s; 'type' should be of type string", ref));
                    }
                    if (!SUPPORTED_FUNCTION_PARAMETER_TYPES.contains(parameterMetadata.get(REGISTER_PARAMETER_TYPE))) {
                        throw new RuntimeException(String.format("Invalid parameter registration for method %s; '%s' type not supported; Supported values are: %s", ref, parameterMetadata.get(REGISTER_PARAMETER_TYPE), SUPPORTED_FUNCTION_PARAMETER_TYPES));
                    }

                });
            }
        }
    }

    private List<Map<String, Object>> extractMethodParams(Map<String, Object> methodMetadata, Map<String, String> paramNameValueMap) {
        if (!methodMetadata.containsKey(REGISTER_FUNCTION_PARAMETERS)) {
            return new ArrayList<>();
        }
        List<Map<String, Object>> result = new ArrayList<>();
        List<Map<String, String>> parametersMetadata = (List<Map<String, String>>) methodMetadata.get(REGISTER_FUNCTION_PARAMETERS);

        for (Map<String, String> parameterMetadata : parametersMetadata) {
            Map<String, Object> parameter = new HashMap<>();
            String paramType = parameterMetadata.get(REGISTER_PARAMETER_TYPE);
            parameter.put("name", parameterMetadata.get(REGISTER_PARAMETER_NAME));
            parameter.put("type", paramType);
            parameter.put("isString", "string".equals(paramType) || CORE_TYPES_MAP.containsKey(paramType));
            if (CORE_TYPES_MAP.containsKey(paramType)) {
                parameter.put("format", paramType);
            }
            parameter.put("value", paramNameValueMap.get(parameterMetadata.get(REGISTER_PARAMETER_NAME)));
            result.add(parameter);
        }
        return result;
    }

    private String extractMethodName(Map<String, Object> methodMetadata) {
        return generateNativeMethodIdentifier(methodMetadata);
    }

    private Map<String, Map<String, String>> extractImports(Map<String, Object> methodMetadata) {
        //<what, as what, from where>
        Map<String, Map<String, String>> imports = new HashMap<>();
        Map<String, String> methodImport = new HashMap<>();
        methodImport.put("what", (String) methodMetadata.get(REGISTER_FUNCTION_NAME));
        String importKey = generateNativeMethodIdentifier(methodMetadata);
        methodImport.put("as", importKey);
        methodImport.put("from", (String) methodMetadata.get(REGISTER_FUNCTION_MODULE));
        List<Map<String, String>> parametersMetadata = methodMetadata.containsKey(REGISTER_FUNCTION_PARAMETERS)
                ? (List<Map<String, String>>) methodMetadata.get(REGISTER_FUNCTION_PARAMETERS)
                : new ArrayList<>();
        for (Map<String, String> param : parametersMetadata) {
            String declaredParamType = param.get(REGISTER_PARAMETER_TYPE);
            if (CORE_TYPES_MAP.containsKey(declaredParamType)) {
                CoreTypeMetadata meta = CORE_TYPES_MAP.get(declaredParamType);
                String coreType = meta.type;
                Map<String, String> paramImport = new HashMap<>();
                paramImport.put("what", coreType);
                paramImport.put("from", meta.source.toString());
                imports.put(coreType, paramImport);
            }
        }
        imports.put(importKey, methodImport);
        return imports;
    }

    private String generateNativeMethodIdentifier(Map<String, Object> methodMetadata) {
        return generateIdentifier(methodMetadata, REGISTER_FUNCTION_NAME, REGISTER_FUNCTION_MODULE);
    }

    private String generateJsoantaImplementationIdentifier(Map<String, Object> methodMetadata) {
        return generateIdentifier(methodMetadata, JSONATA_FUNCTION_IMPLEMENTATION_METHOD_NAME, JSONATA_FUNCTION_IMPLEMENTATION_MODULE);
    }

    private String generateIdentifier(Map<String, Object> metadata, String fieldName, String fieldNamespace) {
        return metadata.get(fieldName) + Arrays.stream(((String) metadata.get(fieldNamespace)).replace("@", "_").split("/")).map(StringUtils::camelize).reduce("", String::concat);
    }

    @Override
    public void processOpts() {
        super.processOpts();
        supportingFiles.add(new SupportingFile("models.mustache", modelPackage().replace('.', File.separatorChar), "index.ts"));
        supportingFiles.add(new SupportingFile("api-all.mustache", apiPackage().replace('.', File.separatorChar), "index.ts"));
        supportingFiles.add(new SupportingFile("manifest.mustache", apiPackage().replace('.', File.separatorChar), "manifest.json"));
        supportingFiles.add(new SupportingFile("USAGE.mustache", "generated", "USAGE.md"));
    }

    @Override
    protected void addImports(Set<String> importsToBeAddedTo, Set<String> importsToAdd) {
        super.addImports(
                importsToBeAddedTo,
                importsToAdd
                    .stream()
                    .filter(i -> !Strings.isNullOrEmpty(i))
                    .map(i -> i.replace(" ","").split("[|&<>]"))
                    .flatMap(types -> Arrays.stream(types))
                    .collect(Collectors.toSet()));
    }

    // The purpose of this override and associated methods is to allow for automatic conversion
    // from 'file' type to the built in node 'Buffer' type
    @Override
    @SuppressWarnings("rawtypes")
    public String getSchemaType(Schema p) {
        if (CORE_TYPES_MAP.containsKey(p.getFormat())) {
            return CORE_TYPES_MAP.get(p.getFormat()).type;
        }
        String openAPIType = super.getSchemaType(p);
        if (isLanguagePrimitive(openAPIType) || isLanguageGenericType(openAPIType)) {
            return openAPIType;
        }
        return applyLocalTypeMapping(openAPIType);
    }

    private String applyLocalTypeMapping(String type) {
        if (typeMapping.containsKey(type)) {
            return typeMapping.get(type);
        }
        return type;
    }

    private boolean isLanguagePrimitive(String type) {
        return languageSpecificPrimitives.contains(type);
    }

    // Determines if the given type is a generic/templated type (ie. ArrayList<String>)
    private boolean isLanguageGenericType(String type) {
        for (String genericType : languageGenericTypes) {
            if (type.startsWith(genericType + "<")) {
                return true;
            }
        }
        return false;
    }

    private boolean isPaginated(CodegenOperation operation) {
      if (operation != null
        && "array".equalsIgnoreCase(operation.returnContainer)
        && operation.getHasResponseHeaders()
        && operation.getHasQueryParams()) {
          return operation.queryParams.stream()
                  .filter(param -> PAGE_SIZE.equals(param.baseName))
                  .findFirst()
                  .isPresent()
                && operation.queryParams.stream()
                  .filter(param ->
                    PAGE_NUMBER.equals(param.baseName) || PAGE_TOKEN.equals(param.baseName)
                  )
                  .distinct()
                  .count() == 1
                && operation.responseHeaders.stream()
                  .filter(header -> PAGED_LINK_HEADER.equals(header.baseName))
                  .findFirst()
                  .isPresent();

      }
      return false;
    }

    private boolean hasSortParams(CodegenOperation operation) {
        return operation.queryParams.stream()
            .filter(param ->
                    SORT_BY.equals(param.baseName) || SORT_DIRECTION.equals(param.baseName)
                   )
            .distinct()
            .count() == 2;
    }

    private String getApiFilenameFromClassname(String classname) {
        return toApiFilename(classname);
    }

    private String getModelnameFromModelFilename(String filename) {
        String name = filename.substring((modelPackage() + File.separator).length());
        return camelize(name);
    }

    @Override
    @SuppressWarnings("rawtypes")
    protected void addAdditionPropertiesToCodeGenModel(CodegenModel codegenModel, Schema schema) {
        super.addAdditionPropertiesToCodeGenModel(codegenModel, schema);
        Schema additionalProperties = getAdditionalProperties(schema);
        codegenModel.additionalPropertiesType = getSchemaType(additionalProperties);
        if ("array".equalsIgnoreCase(codegenModel.additionalPropertiesType)) {
            codegenModel.additionalPropertiesType += '<' + getSchemaType(((ArraySchema) additionalProperties).getItems()) + '>';
        }
        addImport(codegenModel, codegenModel.additionalPropertiesType);
    }

    @Override
    public Map<String, Object> postProcessSupportingFileData(Map<String, Object> objs) {
        Map<String, Object> processed = super.postProcessSupportingFileData(objs);
        processed.put("apiName", this.apiName);
        processed.put("jsonataFunctions", this.jsonataFunctions);
        processed.put("jsonataExpressions", this.jsonataExpressions);
        processed.put("hasInvoker", hasInvoker);
        
        // Add variables for USAGE.md generation
        processed.put("generatedDate", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'").format(new java.util.Date()));
        String packageName = (String) additionalProperties.getOrDefault("packageName", "module");
        processed.put("packageName", packageName);
        processed.put("packageNameKebab", packageName.replaceAll("@[^/]+/", "").replace("module-", ""));
        
        // Check if this is a connector module (has ConnectionProfile model)
        boolean isConnectorModule = this.openAPI.getComponents() != null &&
            this.openAPI.getComponents().getSchemas() != null &&
            this.openAPI.getComponents().getSchemas().containsKey("ConnectionProfile");
        processed.put("isConnector", isConnectorModule);

        if (usesJsonata) {
            supportingFiles.add(new SupportingFile("jsonata-util.mustache", apiPackage().replace('.', File.separatorChar), "jsonataUtil.ts"));
        }

        try {
            JsonNode node = new ObjectMapper().readTree(HubModuleCodegenGenerator.class.getClassLoader().getResourceAsStream("package.json"));
            processed.put("codegenVersion", node.get("version").asText());
        } catch (IOException e) {
            LOGGER.warn("Could not read codegen version", e);
            processed.put("codegenVersion", "0.0.0");
        }
        return processed;
    }

    @Override
    @SuppressWarnings("unchecked")
    public void processOpenAPI(OpenAPI openAPI) {
        String[] parts = openAPI.getInfo().getTitle().split("/");
        String apiName = parts[parts.length - 1];
        apiName = apiName.replaceFirst("^module-", "");

        Map<String, Object> extensions = openAPI.getInfo().getExtensions();
        if (extensions != null && extensions.containsKey("x-impl-name")) {
          apiName = (String)extensions.get("x-impl-name");
        }

        this.apiName = camelize(apiName);

        this.jsonataFunctions = validateJsonataFunctionRegistration(openAPI);
        this.jsonataExpressions = validateJsonataExpressionsRegistration(openAPI);
        this.isAutoGenerate = openAPI.getExtensions() != null && Boolean.TRUE.equals(openAPI.getExtensions().get(X_AUTO_GENERATE));

        if (openAPI.getExtensions() != null && openAPI.getExtensions().containsKey(X_INPUT_PIPELINE)) {
            this.globalInputPipeline.addAll((List<Map<String, Object>>)openAPI.getExtensions().get(X_INPUT_PIPELINE));
        }
        if (openAPI.getExtensions() != null && openAPI.getExtensions().containsKey(X_OUTPUT_PIPELINE)) {
            this.globalOutputPipeline.addAll((List<Map<String, Object>>)openAPI.getExtensions().get(X_OUTPUT_PIPELINE));
        }

        // TODO: registered native functions
        Map<String, Map<String, Object>> defaultInputNativeFunctions = new HashMap<>();
        Map<String, Map<String, Object>> defaultOutputNativeFunctions = new HashMap<>();
        this.inputNativeFunctions = mergeDefaultWithRegisteredNativeFunctions(X_INPUT_PIPELINE_REGISTRY, defaultInputNativeFunctions);
        this.outputNativeFunctions = mergeDefaultWithRegisteredNativeFunctions(X_OUTPUT_PIPELINE_REGISTRY, defaultOutputNativeFunctions);

        validateMethodRegistration(inputNativeFunctions);
        validateMethodRegistration(outputNativeFunctions);
    }

    private Map<String, List< Map<String, Object>>> validateJsonataExpressionsRegistration(OpenAPI openAPI) {
        if (openAPI.getExtensions() == null || !openAPI.getExtensions().containsKey(X_JSONATA_EXPRESSIONS)) {
            return new HashMap<>();
        }
        String jsoanataExpressionsErrorMessage = "Invalid jsonata expressions registration; Examples: \n" +
                X_JSONATA_EXPRESSIONS + ":\n" +
                REGISTER_JSONATA_INLINE_EXPRESSION_EXAMPLE +
                "or" +
                X_JSONATA_EXPRESSIONS + ":\n" +
                REGISTER_JSONATA_IMPORT_EXPRESSION_EXAMPLE;
        checkFieldInMap(jsoanataExpressionsErrorMessage,
                openAPI.getExtensions(),
                X_JSONATA_EXPRESSIONS,
                Lists.newArrayList(Map.class));

        Map<String, List< Map<String, Object>>> registeredJsonataExpressions = new HashMap<>();

        Map<String, Object> jsonataExpressionObjects = (Map<String, Object>) openAPI.getExtensions().get(X_JSONATA_EXPRESSIONS);
        jsonataExpressionObjects.forEach((expressionRef, expressionMetadata) -> {
            String generalErrorMessage = "Invalid jsonata expression registration; Examples: \n" +
                    REGISTER_JSONATA_INLINE_EXPRESSION_EXAMPLE + " \nor\n" +
                    REGISTER_JSONATA_IMPORT_EXPRESSION_EXAMPLE;
            checkField(generalErrorMessage,
                    expressionMetadata, expressionRef, Lists.newArrayList(Map.class));
            Map<String, Object> expressionMetadataMap = (Map<String, Object>) expressionMetadata;
            checkStringFieldInMap(generalErrorMessage, expressionMetadata, JSONATA_EXPRESSION_DESCRIPTION);
            int expectedPropertiesCount;
            if (expressionMetadataMap.containsKey(JSONATA_EXPRESSION_INLINED)) {
                expectedPropertiesCount = 3;
                expressionMetadataMap.put(JSONATA_EXPRESSION_REF_NAME, expressionRef);
                registeredJsonataExpressions.computeIfAbsent(INLINED, (key) -> new ArrayList<>()).add(expressionMetadataMap);
            } else {
                expectedPropertiesCount = 4;
                checkStringFieldInMap(generalErrorMessage, expressionMetadataMap, JSONATA_EXPRESSION_NAME);
                checkStringFieldInMap(generalErrorMessage, expressionMetadataMap, JSONATA_EXPRESSION_MODULE);
                expressionMetadataMap.put(EXPRESSION_ALIAS, expressionRef);
                registeredJsonataExpressions.computeIfAbsent(IMPORTED, (key) -> new ArrayList<>()).add(expressionMetadataMap);
            }
            if (expressionMetadataMap.size() != expectedPropertiesCount) {
                throw new RuntimeException(generalErrorMessage);
            }

        });

        return registeredJsonataExpressions;
    }

    private Map<String, List< Map<String, Object>>> validateJsonataFunctionRegistration(OpenAPI openAPI) {
        if (openAPI.getExtensions() == null || !openAPI.getExtensions().containsKey(X_JSONATA_FUNCTIONS)) {
            return new HashMap<>();
        }

        String jsoanataFunctionsErrorMessage = "Invalid jsonata functions registration; Examples: \n" +
                X_JSONATA_FUNCTIONS + ":\n" +
                REGISTER_JSONATA_INLINE_FUNCTION_EXAMPLE +
                "or" +
                X_JSONATA_FUNCTIONS + ":\n" +
                REGISTER_JSONATA_IMPORT_FUNCTION_EXAMPLE;
        checkFieldInMap(jsoanataFunctionsErrorMessage,
                openAPI.getExtensions(),
                X_JSONATA_FUNCTIONS,
                Lists.newArrayList(List.class));


        Map<String, List< Map<String, Object>>> registeredJsonataFunctions = new HashMap<>();
        for (Object jsonataFunctionObject : (List) openAPI.getExtensions().get(X_JSONATA_FUNCTIONS)) {
            checkField("Invalid jsonata expression registration; Examples: \n" +
                            REGISTER_JSONATA_INLINE_FUNCTION_EXAMPLE + " \nor\n" +
                            REGISTER_JSONATA_IMPORT_FUNCTION_EXAMPLE,
                    jsonataFunctionObject,
                    "jsonata function registration",
                    Lists.newArrayList(Map.class));
            Map<String, Object> jsonataFunction = (Map<String, Object>) jsonataFunctionObject;
            if (jsonataFunction.size() > 4 || (jsonataFunction.size() == 4 && !jsonataFunction.containsKey(JSONATA_FUNCTION_SIGNATURE))) {
                throw new RuntimeException(
                        String.format("Jsonata function registration accepts only 4 fields: %s, %s, %s, %s; Provided: %s",
                                JSONATA_FUNCTION_NAME,
                                JSONATA_FUNCTION_IMPLEMENTATION,
                                JSONATA_FUNCTION_SIGNATURE,
                                JSONATA_FUNCTION_DESCRIPTION,
                                jsonataFunction.keySet()
                        )
                );
            }

            checkStringFieldInMap(REGISTER_JSONATA_FUNCTION_NAME_ERROR_MESSAGE, jsonataFunction, JSONATA_FUNCTION_NAME);
            checkStringFieldInMap(REGISTER_JSONATA_FUNCTION_DESCRIPTION_ERROR_MESSAGE, jsonataFunction, JSONATA_FUNCTION_DESCRIPTION);
            checkFieldInMap(REGISTER_JSONATA_FUNCTION_IMPLEMENTATION_ERROR_MESSAGE, jsonataFunction, JSONATA_FUNCTION_IMPLEMENTATION, Lists.newArrayList(String.class, Map.class));
            checkFieldInMap(REGISTER_JSONATA_FUNCTION_SINATURE_ERROR_MESSAGE, jsonataFunction, JSONATA_FUNCTION_SIGNATURE, String.class);
            Object jsonataImplementation = jsonataFunction.get(JSONATA_FUNCTION_IMPLEMENTATION);
            if (jsonataImplementation instanceof Map) {
                Map<String, Object> jsonataImplementationMap = (Map<String, Object>) jsonataImplementation;
                checkStringFieldInMap(REGISTER_JSONATA_FUNCTION_IMPLEMENTATION_ERROR_MESSAGE, jsonataImplementationMap, JSONATA_FUNCTION_IMPLEMENTATION_METHOD_NAME);
                checkStringFieldInMap(REGISTER_JSONATA_FUNCTION_IMPLEMENTATION_ERROR_MESSAGE, jsonataImplementationMap, JSONATA_FUNCTION_IMPLEMENTATION_MODULE);
                Map<String, Object> importedJsonataFunction = new HashMap<>();
                importedJsonataFunction.put(JSONATA_FUNCTION_NAME, jsonataFunction.get(JSONATA_FUNCTION_NAME));
                importedJsonataFunction.put(JSONATA_FUNCTION_SIGNATURE, jsonataFunction.get(JSONATA_FUNCTION_SIGNATURE));
                importedJsonataFunction.put(JSONATA_FUNCTION_IMPLEMENTATION, jsonataImplementationMap);
                jsonataImplementationMap.put("methodAlias", generateJsoantaImplementationIdentifier(jsonataImplementationMap));
                registeredJsonataFunctions.computeIfAbsent(IMPORTED, s -> new ArrayList<>()).add(importedJsonataFunction);
            } else {
                registeredJsonataFunctions.computeIfAbsent(INLINED, s -> new ArrayList<>()).add(jsonataFunction);
            }
        }

        return registeredJsonataFunctions;

    }

    private void checkStringFieldInMap(String generalErrorMessage, Object map, String fieldName) {
        checkFieldInMap(generalErrorMessage, map, fieldName, Lists.newArrayList(String.class));
    }

    private void checkFieldInMap(String generalErrorMessage, Object map, String fieldName, Class fieldType) {
        checkFieldInMap(generalErrorMessage, map, fieldName, Lists.newArrayList(fieldType));
    }

    private void checkFieldInMap(String generalErrorMessage, Object map, String fieldName, List<Class> fieldTypes) {
        Map<String, Object> fieldsMap;
        try {
            fieldsMap = (Map<String, Object>) map;
        } catch (ClassCastException e) {
            throw new RuntimeException(generalErrorMessage);
        }

        checkField(generalErrorMessage, fieldsMap.get(fieldName), fieldName, fieldTypes);
    }

    private void checkField(String generalErrorMessage, Object field, String fieldName, List<Class> fieldTypes) {
        String message = null;
        if (field == null) {
            message = String.format("%s is mandatory", fieldName);
        } else if (fieldTypes.stream().noneMatch((fieldType) -> fieldType.isInstance(field))) {
            message = String.format("%s be of type %s:", fieldName, fieldTypes.stream().map(Class::getSimpleName).collect(Collectors.toList()));
        }

        if (message != null) {
            throw new RuntimeException(generalErrorMessage + ": " + message);
        }
    }
}
