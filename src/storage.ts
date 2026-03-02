import * as fs from 'fs'
import * as path from 'path'

const DATA_DIR = path.join(process.cwd(), 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

let store: Record<string, string> = {}
let writeTimeout: ReturnType<typeof setTimeout> | null = null

function ensureDataDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true })
    }
}

export function load(): void {
    ensureDataDir()
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const raw = fs.readFileSync(CONFIG_FILE, 'utf-8')
            store = JSON.parse(raw)
            console.log(`[Storage] Loaded ${Object.keys(store).length} keys from ${CONFIG_FILE}`)
        } else {
            store = {}
            console.log('[Storage] No existing config file, starting fresh')
        }
    } catch (e) {
        console.error('[Storage] Failed to load config:', e)
        store = {}
    }
}

function writeToDisk(): void {
    try {
        ensureDataDir()
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(store, null, 2), 'utf-8')
    } catch (e) {
        console.error('[Storage] Failed to write config:', e)
    }
}

function scheduleDiskWrite(): void {
    if (writeTimeout) {
        clearTimeout(writeTimeout)
    }
    writeTimeout = setTimeout(() => {
        writeToDisk()
        writeTimeout = null
    }, 500)
}

export async function get(key: string): Promise<string | null> {
    return store[key] ?? null
}

export async function put(key: string, value: string): Promise<void> {
    store[key] = value
    scheduleDiskWrite()
}
