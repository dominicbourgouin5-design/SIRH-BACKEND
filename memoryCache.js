// memoryCache.js
// Cache simple en mémoire (pas besoin d'installation)

const cache = new Map();

function getCache(key) {
    const item = cache.get(key);
    if (!item) return null;
    
    if (item.expiresAt && Date.now() > item.expiresAt) {
        cache.delete(key);
        return null;
    }
    
    return item.data;
}

function setCache(key, data, ttlSeconds = 60) {
    cache.set(key, {
        data: data,
        expiresAt: Date.now() + (ttlSeconds * 1000)
    });
    
    setTimeout(() => {
        if (cache.has(key)) {
            const item = cache.get(key);
            if (item.expiresAt <= Date.now()) {
                cache.delete(key);
            }
        }
    }, ttlSeconds * 1000);
    
    return true;
}

function clearCache(pattern) {
    if (pattern === '*') {
        cache.clear();
        return true;
    }
    
    const searchTerm = pattern.replace('*', '');
    for (const key of cache.keys()) {
        if (key.includes(searchTerm)) {
            cache.delete(key);
        }
    }
    return true;
}

module.exports = { getCache, setCache, clearCache };
