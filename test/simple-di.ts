import { Injectable, Inject } from '../src/decorator/injectable';
import { DbConfig } from './config';
import { Registry } from '../src/service';

@Injectable()
class Database {
  @Inject('a') dbConfig: DbConfig;

  postConstruct() {
    console.log("Creating database", this.dbConfig.getUrl());
  }

  query() {
    console.log("Getting stuff", this.dbConfig.getUrl());
  }
}

@Injectable()
class Service {
  constructor(private db: Database) {
    console.log("Creating service", db);
  }

  doWork() {
    this.db.query();
  }
}


async function run() {
  let inst = await Registry.getInstance(Service);
  inst.doWork();
}

setInterval(() => run(), 1000);