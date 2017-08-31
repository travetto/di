export class DefinableHandler<T extends any> implements ProxyHandler<T> {
  constructor(public target: T) { }

  getPrototypeOf(target: T): object | null {
    return Object.getPrototypeOf(this.target);
  }

  get(target: T, prop: PropertyKey, receiver: any) {
    return this.target[prop];
  }

  has(target: T, prop: PropertyKey) {
    return this.target.hasOwnProperty(prop);
  }

  set(target: T, prop: PropertyKey, value: any) {
    return this.target[prop] = value;
  }

  enumerate?(target: T): PropertyKey[] {
    return Object.keys(this.target);
  }

  ownKeys?(target: T): PropertyKey[] {
    return Object.getOwnPropertyNames(this.target);
  }
}