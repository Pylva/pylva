// API Key auth format — Decision #18: pv_live_{keyId}_{randomPart}

export const API_KEY_PATTERN = /^pv_(?:live|cli)_([a-f0-9]{8})_([a-f0-9]{32})$/;
