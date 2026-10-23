"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {MemoryGuard}=require("./memory-guard");
test("memory cap requires verified cleanup before new entries",async()=>{
 let mb=505,called=0;
 const store={readUsage:async()=>({usageMB:mb,statsErrors:[]}),
  runCleanup:async()=>{called++;mb=480;return {status:"COMPLETED"}}};
 assert.equal((await new MemoryGuard(store).assess()).ok,true);
 assert.equal(called,1);
});
test("unknown/oversized database must WAIT, not submit an entry",async()=>{
 const unknown={readUsage:async()=>({usageMB:NaN,statsErrors:[]}),runCleanup:async()=>({})};
 assert.equal((await new MemoryGuard(unknown).assess()).reason,"MEMORY_SIZE_UNVERIFIED");
 const full={readUsage:async()=>({usageMB:999,statsErrors:[]}),runCleanup:async()=>({status:"COMPLETED"})};
 assert.equal((await new MemoryGuard(full).assess()).reason,"MEMORY_CAPACITY_CIRCUIT");
});
