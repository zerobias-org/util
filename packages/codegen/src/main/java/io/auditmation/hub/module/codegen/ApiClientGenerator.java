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

/**
 * OpenAPI Generator for API Client SDKs
 *
 * Generates TypeScript SDK clients for direct HTTP access to platform services.
 * Unlike hub-module which generates Hub-routed connectors, this generator creates
 * clients that make direct HTTP calls using BaseApiClient.
 *
 * Usage:
 *   hub-generator generate -g api-client -i api.yml -o generated/
 *
 * Generated artifacts:
 *   - api/index.ts: Main client class with connect/disconnect and API getters
 *   - api/*.ts: Per-API interface and HttpImpl classes
 *   - model/*.ts: Model types
 */
public class ApiClientGenerator extends AbstractTypeScriptClientCodegen {

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

    private static final Logger LOGGER = LoggerFactory.getLogger(ApiClientGenerator.class);
    private static final String PAGED_RESULTS = "PagedResults";
    private static final String PAGED_LINK_HEADER = "link";
    private static final String PAGE_SIZE = "pageSize";
    private static final String PAGE_NUMBER = "pageNumber";
    private static final String PAGE_TOKEN = "pageToken";
    private static final String SORT_DIRECTION = "sortDir";
    private static final String SORT_BY = "sortBy";

    private static final String CONNECTION_PROFILE = "ConnectionProfile";
    private static final String DEFAULT_IMPORT_PREFIX = "./";

    SimpleDateFormat DATE_FORMAT = new SimpleDateFormat("yyyy-MM-dd");
    DateTimeFormatter DATE_TIME_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'");

    public static final Map<String, CoreTypeMetadata> CORE_TYPES = new HashMap<>();
    public static final Map<String, CoreTypeMetadata> CORE_TYPES_MAP = new HashMap<>();

    static {
        // AWS types
        CORE_TYPES_MAP.put("arn", new CoreTypeMetadata("Arn", CoreTypeSource.AMAZON));
        CORE_TYPES_MAP.put("awsPartition", new CoreTypeMetadata("AwsPartition", CoreTypeSource.AMAZON));
        CORE_TYPES_MAP.put("awsService", new CoreTypeMetadata("AwsService", CoreTypeSource.AMAZON));

        // MS types
        CORE_TYPES_MAP.put("azureVmSize", new CoreTypeMetadata("AzureVmSize", CoreTypeSource.MICROSOFT));
        CORE_TYPES_MAP.put("azureResourceProvider", new CoreTypeMetadata("AzureResourceProvider", CoreTypeSource.MICROSOFT));

        // Google types
        CORE_TYPES_MAP.put("gcpAccessPolicy", new CoreTypeMetadata("GcpAccessPolicy", CoreTypeSource.GOOGLE));

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
    }

    private String apiName;
    private String basePath = "";
    private Set<String> enumTypes = new HashSet<>();

    public ApiClientGenerator() {
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
        importMapping.clear();

        outputFolder = "generated-code/api-client";
        embeddedTemplateDir = templateDir = "api-client";
        modelTemplateFiles.put("model.mustache", ".ts");
        apiTemplateFiles.put("api-client-single.mustache", ".ts");
        modelPackage = "model";
        apiPackage = "api";

        supportModelPropertyNaming(CodegenConstants.MODEL_PROPERTY_NAMING_TYPE.camelCase);
        setSortModelPropertiesByRequiredFlag(Boolean.TRUE);

        apiNameSuffix = "Api";

        LOGGER.debug("{}", System.getProperties());
    }

    @Override
    public String getName() {
        return "api-client";
    }

    @Override
    public String getHelp() {
        return "Generates a TypeScript API Client SDK for direct HTTP access";
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
        
        String result = super.getTypeDeclaration(p);
        
        // Remove HTML entities that break TypeScript compilation
        if (result != null) {
            result = result.replace("&lt;", "<");
            result = result.replace("&gt;", ">");
            result = result.replace("&amp;", "&");
            result = result.replace("&quot;", "\"");
        }
        
        return result;
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

            // don't generate class for PagedResults
            if (key.equals(PAGED_RESULTS) || key.contains(PAGED_RESULTS + "_allOf")) {
                LOGGER.info("Removing model {} from generation", key);
                iter.remove();
                continue;
            }

            LOGGER.info("Post-processing model {}", key);

            Map<String, Object> inner = (Map<String, Object>) entry.getValue();
            List<Map<String, Object>> models = (List<Map<String, Object>>) inner.get("models");

            CodegenModel model = (CodegenModel) models.get(0).get("model");
            List<CodegenModel> ifaceModels = model.getInterfaceModels();
            if (ifaceModels != null) {
                for (CodegenModel ifaceModel : ifaceModels) {
                    if (ifaceModel.getName().equals(PAGED_RESULTS)) {
                        throw new IllegalStateException("API Client SDKs must not explicitly define PagedResults types");
                    }
                }
            }

            for (Map<String, Object> mo : models) {
                CodegenModel cm = (CodegenModel) mo.get("model");
                Set<String> imports = new HashSet<>();
                cm.getVars().forEach((cp) -> processEnum(cp, imports, cm.getClassname()));
                CodegenModel loopModel = cm;
                List<CodegenProperty> parentVars = new ArrayList<>();
                imports.addAll(cm.getImports());
                if (cm.isEnum || cm.hasEnums) {
                    imports.add("EnumValue");
                    imports.add("IllegalArgumentError");
                }
                while (loopModel.getParent() != null && loopModel.getParentModel() != null) {
                    loopModel = loopModel.getParentModel();
                    imports.addAll(loopModel.getImports());
                    parentVars = Stream.of(loopModel.getVars(), parentVars)
                            .flatMap(Collection::stream)
                            .collect(Collectors.toList());
                }

                parentVars.forEach((cp) -> processEnum(cp, imports, cm.getClassname()));
                cm.setImports(imports);
                cm.setParentVars(parentVars);

                mo.put("tsImports", toTsImports(cm, cm.imports));
                mo.put("b64Schema", Base64.getEncoder().encodeToString(cm.modelJson.getBytes()));
            }
        }
        return result;
    }

    private void processEnum(CodegenProperty cp, Set<String> imports, String namespace) {
        LOGGER.info("Checking if {} is an enum...", cp.dataType);
        if (this.enumTypes.contains(cp.dataType)) {
            if (!cp.getDatatypeWithEnum().equals(cp.getDataType() + "Def")) {
                cp.setDatatypeWithEnum(cp.getDataType() + "Def");
            }
            imports.add(cp.getDatatypeWithEnum());
        }

        if (cp.isEnum) {
            String enumName = (namespace != null ? namespace + "." : "") + cp.enumName;
            if (!Objects.equals(cp.dataType + "Def", cp.datatypeWithEnum)
                    || !Objects.equals(cp.dataType, enumName)) {
                cp.dataType = enumName;
                cp.datatypeWithEnum = enumName + "Def";
            }
        }

        if (cp.isArray) {
            processEnum(cp.items, imports, namespace);
            cp.dataType = "Array<" + cp.items.dataType + ">";
            cp.datatypeWithEnum = "Array<" + cp.items.datatypeWithEnum + ">";
        }

        CodegenComposedSchemas composed = cp.getComposedSchemas();
        if (composed != null) {
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
            for (CodegenProperty prop : toProcess) {
                processEnum(prop, imports, namespace);
                dataTypes.add(prop.dataType);
                dataTypesWithEnum.add(prop.datatypeWithEnum);
            }
            cp.dataType = String.join(delimiter, dataTypes);
            cp.datatypeWithEnum = String.join(delimiter, dataTypesWithEnum);
        }
    }

    private List<Map<String, String>> toTsImports(CodegenModel cm, Set<String> imports) {
        List<Map<String, String>> tsImports = new ArrayList<>();
        Map<String, Set<String>> typesImports = new HashMap<>();
        for (String im : imports) {
            if (cm == null || !im.equals(cm.classname)) {
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
        return stripped;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Map<String, Object> postProcessOperationsWithModels(Map<String, Object> operations, List<Object> allModels) {
        operations.put("apiName", this.apiName);

        Map<String, Object> objs = (Map<String, Object>) operations.get("operations");

        // The api.mustache template requires all of the auth methods for the whole api
        Map<String, CodegenSecurity> authMethodsMap = new HashMap<>();
        List<CodegenOperation> ops = (List<CodegenOperation>) objs.get("operation");
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

            if ("GET".equals(op.httpMethod)) {
                op.vendorExtensions.put("x-is-get-method", true);
            }
            if ("DELETE".equals(op.httpMethod)) {
                op.vendorExtensions.put("x-is-delete-method", true);
            }
            // When there's a single body parameter, spread it: { ...param } instead of { param }
            // This applies regardless of path params count (e.g., PUT /resource/{id} with body)
            if (op.bodyParams.size() == 1) {
                CodegenParameter bodyParam = op.bodyParams.get(0);
                // Check if body param is a binary/file type that cannot be spread
                boolean isBinaryBody = isDataTypeFile(bodyParam.dataType)
                    || "Buffer".equals(bodyParam.dataType)
                    || bodyParam.isBinary
                    || bodyParam.isFile;
                // Check if body param is an array type that cannot be spread into an object
                boolean isArrayBody = bodyParam.isArray;
                // Check if body param is a primitive type that cannot be spread
                boolean isPrimitiveBody = bodyParam.isString
                    || bodyParam.isInteger
                    || bodyParam.isLong
                    || bodyParam.isNumber
                    || bodyParam.isFloat
                    || bodyParam.isDouble
                    || bodyParam.isBoolean;
                if (isBinaryBody) {
                    op.vendorExtensions.put("x-is-binary-body", true);
                } else if (isArrayBody) {
                    op.vendorExtensions.put("x-is-array-body", true);
                } else if (isPrimitiveBody) {
                    op.vendorExtensions.put("x-is-primitive-body", true);
                } else {
                    op.vendorExtensions.put("x-single-body-param", true);
                }
            }

            if (op.vendorExtensions.containsKey("x-method-name")) {
                op.nickname = (String) op.vendorExtensions.get("x-method-name");
            }

            if (op.hasAuthMethods) {
                for (CodegenSecurity sec : op.authMethods) {
                    authMethodsMap.put(sec.name, sec);
                }
            }

            if (isPaginated(op)) {
                LOGGER.info("Transforming from {} to PagedResults", op.returnType);
                op.returnContainer = PAGED_RESULTS;
                op.returnType = PAGED_RESULTS + "<" + op.returnBaseType + ">";
                if (hasSortParams(op)) {
                    op.vendorExtensions.put("x-has-sort", true);
                }
            }

            List<CodegenParameter> allActualParams = new ArrayList<>();
            allActualParams.addAll(op.allParams);
            allActualParams.addAll(op.queryParams);
            allActualParams.addAll(op.pathParams);

            if (op.returnType != null && op.returnType.startsWith(PAGED_RESULTS)) {
                op.vendorExtensions.put("x-returns-paged-results", true);
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
                operations.put("enums", enums);
            }

            for (CodegenParameter param : allActualParams) {
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

                if (param.isString && !param.isEnum && !param.dataType.equalsIgnoreCase("string")) {
                    param.isString = false;
                    if (param.defaultValue != null) {
                        param.defaultValue = "new " + typeMapping.get(param.dataFormat) + "(" + param.defaultValue + ")";
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
                op.returnType = op.returnType + "Def";
            }
            if (op.returnType != null && op.returnType.startsWith("any")) {
                op.vendorExtensions.put("x-returns-any", true);
            }
            op.vendorExtensions.put("x-returns-file", "RequestFile".equals(op.returnType));
        }

        operations.put("inlineEnums", apiInlineEnums.values());
        operations.put("hasInlineEnums", !apiInlineEnums.isEmpty());
        operations.put("producerName", toApiName(toApiBaseName((String) objs.get("classname")) + "Producer"));

        if (!authMethodsMap.isEmpty()) {
            operations.put("authMethods", authMethodsMap.values());
            operations.put("hasAuthMethods", true);
        }

        objs.put("apiFilename", getApiFilenameFromClassname(objs.get("classname").toString()));

        List<Map<String, Object>> imports = (List<Map<String, Object>>) operations.get("imports");
        Iterator<Map<String, Object>> iter = imports.iterator();
        StringBuilder modelImportsBuilder = new StringBuilder();
        Map<String, Set<String>> tsImports = new HashMap<>();

        while (iter.hasNext()) {
            Map<String, Object> im = iter.next();
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

    @Override
    public void processOpts() {
        super.processOpts();
        supportingFiles.add(new SupportingFile("models.mustache", modelPackage().replace('.', File.separatorChar), "index.ts"));
        supportingFiles.add(new SupportingFile("api-client-all.mustache", apiPackage().replace('.', File.separatorChar), "index.ts"));
        supportingFiles.add(new SupportingFile("manifest.mustache", apiPackage().replace('.', File.separatorChar), "manifest.json"));
        supportingFiles.add(new SupportingFile("USAGE.mustache", "", "USAGE.md"));
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

    @Override
    @SuppressWarnings("rawtypes")
    public String getSchemaType(Schema p) {
        if (CORE_TYPES_MAP.containsKey(p.getFormat())) {
            return CORE_TYPES_MAP.get(p.getFormat()).type;
        }
        String openAPIType = super.getSchemaType(p);
        
        // Remove HTML entities that break TypeScript compilation
        if (openAPIType != null) {
            openAPIType = openAPIType.replace("&lt;", "<");
            openAPIType = openAPIType.replace("&gt;", ">");
            openAPIType = openAPIType.replace("&amp;", "&");
            openAPIType = openAPIType.replace("&quot;", "\"");
        }
        
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
        processed.put("basePath", this.basePath);
        processed.put("generatedDate", new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'").format(new Date()));
        processed.put("packageName", additionalProperties.getOrDefault("packageName", "sdk"));
        processed.put("specFile", additionalProperties.getOrDefault("specFile", "api.yml"));

        try {
            JsonNode node = new ObjectMapper().readTree(ApiClientGenerator.class.getClassLoader().getResourceAsStream("package.json"));
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
            apiName = (String) extensions.get("x-impl-name");
        }

        this.apiName = camelize(apiName);

        // Extract base path from servers[0].url for SDK base path
        if (openAPI.getServers() != null && !openAPI.getServers().isEmpty()) {
            String serverUrl = openAPI.getServers().get(0).getUrl();
            // Only use if it's a path (starts with /) and not just "/"
            if (serverUrl != null && serverUrl.startsWith("/") && !serverUrl.equals("/")) {
                this.basePath = serverUrl;
                LOGGER.info("Using base path from servers[0].url: {}", this.basePath);
            }
        }
    }

    /**
     * Override escapeText to prevent HTML entity encoding in generated TypeScript
     * 
     * The parent AbstractTypeScriptClientCodegen escapes < and > to &lt; and &gt;
     * which breaks TypeScript compilation in enum maps and type definitions.
     */
    @Override
    public String escapeText(String input) {
        if (input == null) {
            return input;
        }
        
        // Don't escape HTML entities - just return the input as-is
        // This prevents < and > from being converted to &lt; and &gt;
        return input;
    }


    /**
     * Override toVarName to ensure variable names don't contain HTML entities
     */
    @Override
    public String toVarName(String name) {
        String result = super.toVarName(name);
        
        // Remove HTML entities from variable names
        if (result != null) {
            result = result.replace("&lt;", "<");
            result = result.replace("&gt;", ">");
            result = result.replace("&amp;", "&");
            result = result.replace("&quot;", "\"");
        }
        
        return result;
    }
}
