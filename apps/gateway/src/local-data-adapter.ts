import { join } from 'node:path'
import type { ProductDataStore } from './product-service.js'

export interface ProductStoreLoadResult {
  store?: ProductDataStore
  doctor?: { code: string; message: string }
}

export interface LocalDataModule {
  createLocalDataStore(options: { dataDir: string }): Promise<ProductDataStore>
}

export interface LocalDataLoadOptions {
  dshHome?: string
  dataRoot?: string
  importModule?: () => Promise<LocalDataModule>
}

async function importLocalData(): Promise<LocalDataModule> {
  const packageName = '@dsh-rp/local-data'
  return import(packageName) as Promise<LocalDataModule>
}

export async function loadDefaultProductStore(options: LocalDataLoadOptions): Promise<ProductStoreLoadResult> {
  const base = options.dshHome ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.cwd(), '.dsh')
  const dataDir = options.dataRoot ?? process.env.DSH_RP_DATA_ROOT ?? join(base, 'app-data')
  try {
    const module = await (options.importModule ?? importLocalData)()
    if (typeof module.createLocalDataStore !== 'function') return { doctor: { code: 'local-data-contract-invalid', message: '本地数据包没有导出 createLocalDataStore。' } }
    return { store: await module.createLocalDataStore({ dataDir }) }
  } catch {
    return { doctor: { code: 'local-data-load-failed', message: '本地数据包未能加载，产品数据功能暂不可用。' } }
  }
}
