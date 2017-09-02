import * as path from 'path';

import { Class, Dependency, InjectableConfig, ClassTarget } from '../types';
import { AppInfo, bulkRequire } from '@encore/base';
import { RetargettingHandler } from '@encore/compiler';
import { InjectionError } from './error';
import { externalPromise } from '@encore/util';

export const DEFAULT_INSTANCE = '__default';

export interface ManagedExtra {
  postConstruct?: () => any
}

const SEP = path.sep;
const RE_SEP = SEP === '/' ? '\\/' : SEP;
const SRC_RE = new RegExp(`${RE_SEP}src${RE_SEP}`, 'g');
const PATH_RE = new RegExp(RE_SEP, 'g');

function getId<T>(cls: Class<T> | ClassTarget<T>): string {
  let target = cls as any;

  if (!target.__id) {
    let rootName = cls.__filename!
      .split(process.cwd())[1]
      .replace(SRC_RE, SEP)
      .replace(PATH_RE, '.')
      .replace(/^\./, '')
      .replace(/\.(t|j)s$/, '');

    target.__id = `${rootName}#${cls.name}`;
  }
  return target.__id;
}

export class DependencyRegistry {
  static pendingInjectables = new Map<string, InjectableConfig<any>>();
  static injectables = new Map<string, InjectableConfig<any>>();
  static instances = new Map<string, Map<string, any>>();
  static proxyHandlers = new Map<string, Map<string, any>>();

  static aliases = new Map<string, Map<string, string>>();
  static autoCreate: (Dependency<any> & { priority: number })[] = [];

  private static _waitingForInit = false;
  static initalized = externalPromise();

  static getId = getId;

  static async construct<T>(target: ClassTarget<T & ManagedExtra>, name: string = DEFAULT_INSTANCE): Promise<T> {
    let targetId = getId(target);

    let aliasMap = this.aliases.get(targetId);

    if (!aliasMap || !aliasMap.has(name)) {
      throw new InjectionError(`Dependency not found: ${targetId}[${name}]`);
    }

    let clz = aliasMap.get(name)!;
    let managed = this.injectables.get(clz)!;

    const fieldKeys = Object.keys(managed.dependencies.fields!);

    const promises =
      managed.dependencies.cons
        .concat(fieldKeys.map(x => managed.dependencies.fields[x]))
        .map(async x => {
          try {
            return await this.getInstance(x.target, x.name);
          } catch (e) {
            if (x.optional && e instanceof InjectionError) {
              return undefined;
            } else {
              throw e;
            }
          }
        });

    const allDeps = await Promise.all(promises);

    const consValues = allDeps.slice(0, managed.dependencies.cons.length);
    const fieldValues = allDeps.slice(managed.dependencies.cons.length);

    const inst = new managed.class(...consValues);

    for (let i = 0; i < fieldKeys.length; i++) {
      (inst as any)[fieldKeys[i]] = fieldValues[i];
    }

    if (inst.postConstruct) {
      await inst.postConstruct();
    }
    return inst;
  }

  private static async createInstance<T>(target: ClassTarget<T>, name: string = DEFAULT_INSTANCE) {
    let instance = await this.construct(target, name);
    let targetId = getId(target);

    if (!this.instances.has(targetId)) {
      this.instances.set(targetId, new Map());
      this.proxyHandlers.set(targetId, new Map());
    }

    let out: any = instance;

    if (AppInfo.WATCH_MODE) {
      if (!this.instances.has(targetId) || !this.instances.get(targetId)!.has(name)) {
        console.log('Registering proxy', target.name, name);
        let handler = new RetargettingHandler(out);
        out = new Proxy({}, handler);
        this.proxyHandlers.get(targetId)!.set(name, handler);
      } else {
        console.log('Updating target');
        this.proxyHandlers.get(targetId)!.get(name)!.target = out;
        // Don't re-set instance
        return;
      }
    }

    this.instances.get(targetId)!.set(name, out);
  }

  static async getInstance<T>(target: ClassTarget<T>, name: string = DEFAULT_INSTANCE): Promise<T> {
    let targetId = getId(target);
    if (!this.instances.has(targetId) || !this.instances.get(targetId)!.has(name)) {
      await this.createInstance(target, name);
    }
    return this.instances.get(targetId)!.get(name)!;
  }

  static getCandidateTypes<T>(target: Class<T>) {
    let targetId = getId(target);
    let aliasMap = this.aliases.get(targetId)!;
    let aliasedIds = aliasMap ? Array.from(aliasMap.values()) : [];
    return aliasedIds.map(id => this.injectables.get(id)!)
  }

  static async initialize() {
    if (!this._waitingForInit) {
      try {
        this._waitingForInit = true;
        let globs = (process.env.SCAN_GLOBS || 'node_modules/@encore/*/src/**/*.ts src/**/*.ts').split(/\s+/);
        for (let glob of globs) {
          bulkRequire(glob, undefined, p => p.indexOf('/ext/') < 0 && !p.endsWith('.d.ts'));
        }

        if (this.autoCreate.length) {
          console.log('Auto-creating', this.autoCreate.map(x => x.target.name));
          let items = this.autoCreate.slice(0).sort((a, b) => a.priority - b.priority);
          for (let i of items) {
            await this.getInstance(i.target, i.name);
          }
        }
      } catch (e) {
        console.log(e);
        throw e;
      }
      this.initalized.resolve(true);
    }
    return await this.initalized;
  }

  static getOrCreatePendingConfig<T>(cls: Class<T>) {
    let id = getId(cls);
    if (!this.pendingInjectables.has(id)) {
      this.pendingInjectables.set(id, {
        name: DEFAULT_INSTANCE,
        class: cls,
        target: cls,
        dependencies: {
          fields: {},
          cons: []
        },
        autoCreate: {
          create: false,
          priority: 1000
        }
      } as any as InjectableConfig<T>);
    }
    return this.pendingInjectables.get(id)!;
  }

  static registerConstructor<T>(cls: Class<T>, dependencies: Dependency<any>[]) {
    let conf = this.getOrCreatePendingConfig(cls);
    conf.dependencies.cons = dependencies;
    for (let dependency of dependencies) {
      dependency.name = dependency.name || DEFAULT_INSTANCE;
    }
  }

  static registerProperty<T>(cls: Class<T>, field: string, dependency: Dependency<any>) {
    let conf = this.getOrCreatePendingConfig(cls);
    conf.dependencies.fields[field] = dependency;
    dependency.name = dependency.name || DEFAULT_INSTANCE;
  }

  static finalizeClass<T>(pconfig: Partial<InjectableConfig<T>>) {
    let classId = getId(pconfig.class!);
    let config = this.getOrCreatePendingConfig(pconfig.class!);

    if (pconfig.name) {
      config.name = pconfig.name;
    }
    if (pconfig.target) {
      config.target = pconfig.target;
    }
    if (pconfig.autoCreate) {
      config.autoCreate.create = pconfig.autoCreate.create;
      if (pconfig.autoCreate.priority !== undefined) {
        config.autoCreate.priority = pconfig.autoCreate.priority;
      }
    }

    let targetId = getId(config.target);
    this.injectables.set(classId, config);
    this.pendingInjectables.delete(classId);

    if (!this.aliases.has(targetId)) {
      this.aliases.set(targetId, new Map());
    }

    this.aliases.get(targetId)!.set(config.name, classId);

    // Live RELOAD
    if (AppInfo.WATCH_MODE &&
      this.proxyHandlers.has(targetId) &&
      this.proxyHandlers.get(targetId)!.has(config.name)
    ) {
      this.createInstance(config.target, config.name);
    } else if (config.autoCreate.create) {
      this.autoCreate.push({
        target: config.target,
        name: config.name,
        priority: config.autoCreate.priority!
      })
    }
  }

}