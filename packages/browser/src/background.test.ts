import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { whenSettled } from "@opencua/test-support";
import { z } from "zod";
import { observationSchema } from "./protocol.js";

const harnessSchema = z.object({
	dispatch: z.function({ input: z.tuple([z.unknown()]), output: z.promise(z.unknown()) }),
	stats: z.function({
		input: z.tuple([]),
		output: z.object({
			foreground: z.number(),
			userTab: z.number(),
			windowState: z.string(),
			removed: z.array(z.number()),
			inputs: z.number(),
			evaluates: z.number(),
			observes: z.number(),
			tabWindow: z.number(),
			created: z.number(),
			sent: z.array(z.unknown()),
			windowUpdates: z.array(z.unknown()),
			badge: z.string(),
			handoff: z.unknown(),
		}),
	}),
	valid: z.function({ input: z.tuple([z.unknown()]), output: z.boolean() }),
	move: z.function({ input: z.tuple([]), output: z.void() }),
	reveal: z.function({ input: z.tuple([]), output: z.void() }),
	focus: z.function({ input: z.tuple([]), output: z.promise(z.void()) }),
	message: z.function({ input: z.tuple([z.string()]), output: z.promise(z.unknown()) }),
	handoff: z.function({ input: z.tuple([z.string()]), output: z.promise(z.void()) }),
});

async function harness(
	options: {
		navigateAfterClick?: boolean;
		/** Reads of the agent window that still answer "normal" after it was told to minimize. */
		minimizeLag?: number;
		frameAfterClick?: "child" | "main";
		stopAfterPrepare?: "stop" | "cancel";
	} = {},
) {
	const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
	// Chrome is the external boundary. Execute the shipped worker, substituting
	// only its SDK and page-runtime import; authentication is tested by bridge tests.
	const script = new Script(`
		const pageRuntime = () => {};
		const options=${JSON.stringify(options)};
		let foreground=50, userTab=70, tabWindow=50, inputs=0, evaluates=0, created=0, observes=0;
		let contextId=0, debuggerListener, checkpointAllowed=true;
		const removed=[], sent=[], windowUpdates=[];
		const session={};
		let minimizeLag=options.minimizeLag??0;
		let badge='';
		let runtimeListener;
		const focusListeners=[];
		const window={id:10,focused:false,state:'minimized',tabs:[{id:99}]};
		const event={addListener(){},removeListener(){}};
		const runtimeEvent={addListener(listener){runtimeListener=listener},removeListener(){}};
		const focusEvent={addListener(listener){focusListeners.push(listener)},removeListener(){}};
		const chrome={
			storage:{local:{get:async()=>({}),set:async()=>{}},session:{set:async(value)=>Object.assign(session,value),remove:async(key)=>delete session[key]},onChanged:event},
			action:{setBadgeText:async({text})=>{badge=text},setTitle:async()=>{}},
			runtime:{sendNativeMessage:async()=>{throw Error('No host')},onMessage:runtimeEvent},
			alarms:{create(){},onAlarm:event},
			windows:{
				create:async(options)=>{window.state=options.state;if(options.focused)foreground=10;return window;},
				get:async()=>{if(minimizeLag>0&&window.state==='minimized'){minimizeLag--;return {...window,state:'normal'}}return window},update:async(_id,options)=>{windowUpdates.push(options);window.state=options.state;window.focused=options.focused===true;return window},
				remove:async()=>{},onRemoved:event,onFocusChanged:focusEvent,onBoundsChanged:event
			},
			tabs:{
				create:async(options)=>{
					created++;
					tabWindow=options.windowId??50;
					if(options.active&&tabWindow===50)userTab=100;
					return {id:100,windowId:tabWindow,url:options.url};
				},
				get:async()=>({id:100,windowId:tabWindow,status:'complete'}),
				remove:async(id)=>{removed.push(id)},
				update:async()=>{},onUpdated:event,onRemoved:event,onAttached:event
			},
			debugger:{
				attach:async()=>{},
				sendCommand:async(_target,method,params)=>{
					if(method.startsWith('Input.'))inputs++;
					if(method==='Runtime.evaluate')evaluates++;
					if(method==='Input.dispatchMouseEvent'&&params.type==='mouseReleased'){
						if(options.navigateAfterClick)debuggerListener({tabId:100},'Runtime.executionContextsCleared');
						if(options.frameAfterClick)debuggerListener({tabId:100},'Page.frameNavigated',{
							frame:options.frameAfterClick==='child'?{id:'child',parentId:'frame'}:{id:'frame'}
						});
					}
					if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{clientWidth:100,clientHeight:100}};
					if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame'}}};
					if(method==='Page.createIsolatedWorld'){contextId++;return {executionContextId:1};}
					if(method==='Runtime.evaluate'&&params.expression.includes('"method":"observe"'))
						{ observes++; return {result:{value:{revision:'document'+contextId,rows:[]}}}; }
					if(method==='Runtime.evaluate'&&params.expression.includes('"method":"target"'))
						return {result:{value:{x:10,y:10}}};
					if(method==='Runtime.evaluate'&&params.expression.includes('"method":"prepareFill"'))
						return {result:{value:{ok:true,editable:true}}};
					if(method==='Runtime.evaluate'&&params.expression.includes('"method":"fillComplete"'))
						return {result:{value:{ok:true}}};
					if(method==='Runtime.evaluate'&&params.expression.includes('"method":"resolveTarget"'))
						return {result:{value:{ok:true,ref:1,role:'button',name:'Apply'}}};
					if(method==='Runtime.evaluate'&&params.expression.includes('"method":"selectOption"'))
						return {result:{value:{ok:true,value:'ca',label:'Canada'}}};
					if(method==='Runtime.evaluate'&&params.expression.includes('"method":"revision"'))
						return {result:{value:'document'+contextId}};
					if(method==='Runtime.evaluate'&&params.expression.includes('"method":"wait"'))
						return {result:{value:{matched:true,reason:'matched',revision:'document'+contextId}}};
					if(method==='Runtime.evaluate'&&params.expression.includes('"method":"prepareScroll"')){
						if(options.stopAfterPrepare==='stop')stopLocally();
						if(options.stopAfterPrepare==='cancel')tabsOwned.get(100).cancelled=true;
						return {result:{value:{ok:true,needed:true}}};
					}
					if(method==='Runtime.evaluate'&&params.expression.includes('"method":"scrollComplete"'))
						return {result:{value:{ok:true}}};
					return {};
				},
				onEvent:{addListener(listener){debuggerListener=listener}},onDetach:event
			}
		};
		const WebSocket={OPEN:1};
		${source.replace(/^import .*$/m, "")}
		ready=true;stopped=false;socket={readyState:1,send(raw){
			const packet=JSON.parse(raw);
			sent.push(packet);
			if(packet.event==='checkpoint'){
				const waiter=checkpoints.get(packet.id);
				clearTimeout(waiter.timer);
				checkpoints.delete(packet.id);
				waiter.resolve(checkpointAllowed);
			}
		}};
		({
			dispatch,
			sent,
			stats:()=>({foreground,userTab,windowState:window.state,removed,inputs,evaluates,observes,tabWindow,created,sent:sent.slice(),windowUpdates:windowUpdates.slice(1),badge,handoff:session.handoffRequest}),
			valid:(step)=>validStep(step),
			move:()=>{tabWindow=50},
			reveal:()=>{window.focused=true;window.state='normal'},
			message:async(type)=>new Promise(resolve=>runtimeListener({type},null,resolve)),
			handoff:async(reason)=>handleCommand({id:'handoff-test',command:'handoff',reason}),
			focus:async()=>{window.focused=true;window.state='normal';for(const listener of focusListeners)await listener(10)}
		})
	`);
	const value: unknown = script.runInNewContext({ setTimeout, clearTimeout, setInterval, clearInterval, URL });
	return harnessSchema.parse(value);
}

describe("background worker ownership", () => {
	it("#given Chromium still reports the new window as normal while it minimizes #when opening a page #then it waits for the minimize instead of failing", async () => {
		const worker = await harness({ minimizeLag: 3 });
		await expect(worker.dispatch({ command: "open", url: "https://example.com" })).resolves.toBeDefined();
		expect(worker.stats().created).toBe(1);
	});

	it("#given two pages #when opening both #then reuses one minimized window without activating it", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com/a" });
		await worker.dispatch({ command: "open", url: "https://example.com/b" });
		expect(worker.stats()).toMatchObject({
			created: 2,
			foreground: 50,
			userTab: 70,
			windowState: "minimized",
		});
	});

	it("#given a user window #when opening a page #then keeps the user window and tab unchanged", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		expect(worker.stats()).toMatchObject({
			foreground: 50,
			userTab: 70,
			tabWindow: 10,
			windowState: "minimized",
			removed: [],
		});
	});

	it("#given a background agent #when taking over #then pauses and reveals it", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		expect(await worker.message("take-over")).toMatchObject({ ok: true });
		expect(worker.stats().windowState).toBe("normal");
		expect(worker.stats().windowUpdates).toContainEqual({ state: "normal", focused: true });
		expect(worker.stats().sent).toContainEqual({ event: "control", owner: "human", reason: "taken_over" });
	});

	it("#given a minimized agent window #when focused #then reports human control", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		await worker.focus();
		expect(worker.stats().sent).toContainEqual({ event: "control", owner: "human", reason: "window_revealed" });
	});

	it("#given human control #when giving back #then minimizes and resumes without re-pausing", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		await worker.message("take-over");
		expect(await worker.message("give-back")).toMatchObject({ ok: true });
		expect(worker.stats().windowState).toBe("minimized");
		expect(worker.stats().sent).toContainEqual({ event: "control", owner: "agent" });
		expect(worker.stats().sent).toHaveLength(2);
	});

	it("#given a connected agent #when handoff arrives #then badges without revealing a window", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		await worker.handoff("Please review");
		expect(worker.stats().badge).toBe("!");
		expect(worker.stats().handoff).toMatchObject({ reason: "Please review" });
		expect(worker.stats().windowUpdates).toEqual([]);
		expect(worker.stats().created).toBe(1);
	});

	it("#given an explicit stop #when stopping #then sends the stop event", async () => {
		const worker = await harness();
		await worker.message("stop");
		expect(worker.stats().sent).toContainEqual({ event: "stop" });
	});

	it("#given a timed-out action the bridge cancelled #when the agent runs again on the same page #then it completes", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		await worker.dispatch({ command: "cancel" });
		await expect(
			worker.dispatch({
				command: "run",
				id: "after-cancel",
				tabId: 100,
				revision: "document1",
				limits: { maxChars: 6000, maxElements: 80, fullPage: false },
				steps: [{ action: "click", ref: 1 }],
			}),
		).resolves.toMatchObject({ completedSteps: 1 });
	});

	it("#given a tab moved into a user window #when closing #then refuses to remove it", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		worker.move();
		await expect(worker.dispatch({ command: "close", tabId: 100 })).rejects.toBeDefined();
		expect(worker.stats().removed).toEqual([]);
	});

	it("#given a revealed agent window #when running input #then refuses before dispatch", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		worker.reveal();
		await expect(worker.dispatch({ command: "run", tabId: 100 })).rejects.toBeDefined();
		expect(worker.stats().inputs).toBe(0);
	});

	it("#given a revealed owned window #when opening another tab #then refuses before creation", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		worker.reveal();
		await expect(worker.dispatch({ command: "open", url: "https://example.com/next" })).rejects.toBeDefined();
		expect(worker.stats().created).toBe(1);
	});

	it("#given navigation during a batch #when continuing #then refuses refs from the previous document", async () => {
		const worker = await harness({ navigateAfterClick: true });
		await worker.dispatch({ command: "open", url: "https://example.com" });
		await expect(
			worker.dispatch({
				command: "run",
				id: "navigation",
				tabId: 100,
				revision: "document1",
				limits: { maxChars: 6000, maxElements: 80, fullPage: false },
				steps: [
					{ action: "click", ref: 1 },
					{ action: "click", ref: 1 },
				],
			}),
		).rejects.toBeDefined();
		expect(worker.stats().inputs).toBe(2);
	});

	it("#given a click that loads a new page #when only a wait follows #then the run completes on the new page", async () => {
		const worker = await harness({ navigateAfterClick: true });
		await worker.dispatch({ command: "open", url: "https://example.com" });
		await expect(
			worker.dispatch({
				command: "run",
				id: "submit-then-wait",
				tabId: 100,
				revision: "document1",
				limits: { maxChars: 6000, maxElements: 80, fullPage: false },
				steps: [
					{ action: "click", ref: 1 },
					{ action: "wait", text: "Done", timeoutMs: 1000 },
				],
			}),
		).resolves.toMatchObject({ completedSteps: 2, navigated: true });
	});

	it("#given one document #when running a batch #then completes both grounded clicks", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		await expect(
			worker.dispatch({
				command: "run",
				id: "same-document",
				tabId: 100,
				revision: "document1",
				limits: { maxChars: 6000, maxElements: 80, fullPage: false },
				steps: [
					{ action: "click", ref: 1 },
					{ action: "click", ref: 1 },
				],
			}),
		).resolves.toMatchObject({ completedSteps: 2 });
		expect(worker.stats().inputs).toBe(4);
	});

	it("#given a token observation #when running a batch #then walks the page only for the final result", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		await expect(
			worker.dispatch({
				command: "run",
				id: "no-initial-observe",
				tabId: 100,
				revision: "document1",
				limits: { maxChars: 6000, maxElements: 80, fullPage: false },
				steps: [{ action: "click", ref: 1 }],
			}),
		).resolves.toMatchObject({ completedSteps: 1 });
		expect(worker.stats().observes).toBe(1);
	});

	it("#given a described target #when running a batch #then resolves it inside the page without a separate observe", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		await expect(
			worker.dispatch({
				command: "run",
				id: "described-target",
				tabId: 100,
				revision: "document1",
				limits: { maxChars: 6000, maxElements: 80, fullPage: false },
				steps: [{ action: "click", target: { role: "button", name: "Apply" } }],
			}),
		).resolves.toMatchObject({ completedSteps: 1 });
		expect(worker.stats().inputs).toBe(2);
	});

	it("#given a described target #when running a batch #then resolves and acts in the same page round trip", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		const before = worker.stats().evaluates;
		await expect(
			worker.dispatch({
				command: "run",
				id: "single-resolve",
				tabId: 100,
				revision: "document1",
				limits: { maxChars: 6000, maxElements: 80, fullPage: false },
				steps: [{ action: "click", target: { role: "button", name: "Apply" } }],
			}),
		).resolves.toMatchObject({ completedSteps: 1 });
		expect(worker.stats().evaluates - before).toBe(3);
	});

	it("#given a combobox #when selecting by label #then sets it without pointer input", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		await expect(
			worker.dispatch({
				command: "run",
				id: "select-label",
				tabId: 100,
				revision: "document1",
				limits: { maxChars: 6000, maxElements: 80, fullPage: false },
				steps: [
					{
						action: "select",
						target: { role: "combobox", name: "Country" },
						choice: { label: "Canada" },
					},
				],
			}),
		).resolves.toMatchObject({ completedSteps: 1 });
		expect(worker.stats().inputs).toBe(0);
	});

	it.each([
		["two choices", { value: "ca", label: "Canada" }],
		["no choice", {}],
	] as const)("#given %s #when validating a select step #then refuses it", async (_name, choice) => {
		const worker = await harness();
		expect(worker.valid({ action: "select", target: { role: "combobox", name: "Country" }, choice })).toBe(false);
	});

	it("#given a wait step #when the text is present #then continues the batch without input", async () => {
		const worker = await harness();
		await worker.dispatch({ command: "open", url: "https://example.com" });
		await expect(
			worker.dispatch({
				command: "run",
				id: "wait-step",
				tabId: 100,
				revision: "document1",
				limits: { maxChars: 6000, maxElements: 80, fullPage: false },
				steps: [{ action: "wait", text: "Ready", timeoutMs: 100 }],
			}),
		).resolves.toMatchObject({ completedSteps: 1 });
		expect(worker.stats().inputs).toBe(0);
	});

	it.each(["stop", "cancel"] as const)(
		"#given %s after scroll preparation #when dispatching wheel input #then stops before input",
		async (stopAfterPrepare) => {
			const worker = await harness({ stopAfterPrepare });
			await worker.dispatch({ command: "open", url: "https://example.com" });
			await expect(
				worker.dispatch({
					command: "run",
					id: "scroll",
					tabId: 100,
					revision: "document1",
					limits: { maxChars: 6000, maxElements: 80, fullPage: false },
					steps: [{ action: "scroll", deltaY: 100 }],
				}),
			).rejects.toBeDefined();
			expect(worker.stats().inputs).toBe(0);
		},
	);

	it.each(["child", "main"] as const)(
		"#given %s frame navigation #when continuing a batch #then preserves only the current main context",
		async (frameAfterClick) => {
			const worker = await harness({ frameAfterClick });
			await worker.dispatch({ command: "open", url: "https://example.com" });
			const running = worker.dispatch({
				command: "run",
				id: "frames",
				tabId: 100,
				revision: "document1",
				limits: { maxChars: 6000, maxElements: 80, fullPage: false },
				steps: [
					{ action: "click", ref: 1 },
					{ action: "click", ref: 1 },
				],
			});
			if (frameAfterClick === "child") {
				await whenSettled(running, (settled) => expect(settled).resolves.toMatchObject({ completedSteps: 2 }));
				expect(worker.stats().inputs).toBe(4);
			} else {
				await whenSettled(running, (settled) => expect(settled).rejects.toBeDefined());
				expect(worker.stats().inputs).toBe(2);
			}
		},
	);
});

describe("page runtime shadow targeting", () => {
	it.each(["host", "ancestor", "inner", "obscured"])(
		"#given a role-bearing shadow host #when targeting %s #then recognizes containment before descending",
		async (target) => {
			const source = await readFile(new URL("../extension/page-runtime.js", import.meta.url), "utf8");
			const script = new Script(`
				${source.replace("export function", "function")}
				class Element {
					isConnected=true; tagName='BUTTON'; innerText='Continue';
					getAttribute(){return null} hasAttribute(){return false} matches(){return false}
					getBoundingClientRect(){return {left:0,top:0,width:20,height:20,bottom:20,right:20}}
					scrollIntoView(){}
					contains(other){return this===ancestor && other===host}
				}
				class HTMLInputElement extends Element {}
				class HTMLTextAreaElement extends Element {}
				const ancestor=new Element(), host=new Element(), inner=new Element(), overlay=new Element();
				host.shadowRoot={elementFromPoint:()=>inner};
				const document={
					title:'Example',
					createTreeWalker(root){
						const elements=root===document?[ancestor,host]:[inner];
						let index=0;return {nextNode:()=>elements[index++]??null};
					},
					elementFromPoint:()=>${target === "obscured" ? "overlay" : "host"}
				};
				const location={href:'https://user:secret@example.com/path?token=secret#secret',origin:'https://example.com',pathname:'/path'};
				const MutationObserver=class{observe(){}};
				const NodeFilter={SHOW_ELEMENT:1};
				const getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1'});
				const innerHeight=100,innerWidth=100;
				const observation=pageRuntime({method:'observe'});
				const ref=observation.rows[${target === "ancestor" ? 0 : target === "inner" ? 2 : 1}].ref;
				({observation,result:pageRuntime({method:'target',revision:observation.revision,ref})})
			`);
			const result: unknown = script.runInNewContext();
			if (target === "obscured") expect(result).toMatchObject({ result: { error: "target center is obscured" } });
			else expect(result).toMatchObject({ result: { x: 10, y: 10 } });
			expect(result).toMatchObject({ observation: { url: "https://example.com/path" } });
		},
	);
});

async function pageScenario(scenario: string): Promise<unknown> {
	const source = await readFile(new URL("../extension/page-runtime.js", import.meta.url), "utf8");
	return await new Script(`
		${source.replace("export function", "function")}
		const observers=[], timers=new Map(); let nextTimer=0;
		const setTimeout=(callback)=>{timers.set(++nextTimer,callback);return nextTimer};
		const clearTimeout=(id)=>timers.delete(id);
		class Element {
			isConnected=true; tagName='BUTTON'; innerText='Continue'; hidden=false; value=''; readOnly=false;
			listeners=new Map();
			getAttribute(name){return name==='aria-label'?'Control':name==='hidden'&&this.hidden?'':null}
			hasAttribute(){return false} matches(){return false} contains(other){return other===this}
			getBoundingClientRect(){return {left:0,top:0,width:20,height:20,bottom:20,right:20}}
			scrollIntoView(){} focus(){} select(){}
			addEventListener(name,listener){this.listeners.set(name,listener)}
			removeEventListener(name){this.listeners.delete(name)}
		}
		class HTMLInputElement extends Element {tagName='INPUT';type='text'}
		class HTMLTextAreaElement extends Element {}
		const control=new HTMLInputElement(), host=new Element(), nestedHost=new Element();
		const message=new Element(); message.innerText='Waiting';
		const nestedRoot={children:[message],querySelectorAll:()=>[message]};
		nestedHost.shadowRoot=nestedRoot;
		const shadow={children:[nestedHost],querySelectorAll:()=>[nestedHost]};
		host.shadowRoot=shadow;
		let elements=[control,host];
		const document={
			title:'Example',body:{innerText:'Waiting'},
			querySelectorAll:()=>elements,
			createTreeWalker(root){
				const nodes=root===document?elements:root.querySelectorAll('*');
				let index=0;return {nextNode:()=>nodes[index++]??null}
			}
		};
		const location={href:'https://user:secret@example.com/path?token=secret#secret',origin:'https://example.com',pathname:'/path'};
		class MutationObserver {
			roots=new Set();constructor(callback){this.callback=callback;observers.push(this)}
			observe(root){this.roots.add(root)} disconnect(){this.roots.clear()}
		}
		const NodeFilter={SHOW_ELEMENT:1};
		const getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1'});
		const innerHeight=100,innerWidth=100;
		(async()=>{${scenario}})()
	`).runInNewContext();
}

describe("page runtime verification and privacy", () => {
	it("#given pending verification #when nested shadow text changes #then observes and verifies it", async () => {
		const result = await pageScenario(`
			const pending=pageRuntime({method:'verify',text:'Ready',timeoutMs:1000});
			message.innerText='Ready';
			for(const observer of observers)if(observer.roots.has(nestedRoot))observer.callback();
			for(const callback of timers.values())callback();
			return await pending;
		`);
		expect(result).toEqual({ ok: true });
	});

	it("#given a range input #when observing #then does not advertise an editable textbox", async () => {
		const result = await pageScenario(`
			control.type='range';elements=[control];
			return pageRuntime({method:'observe'});
		`);
		expect(result).toMatchObject({ rows: [] });
	});

	it.each(["hidden", "detached"])(
		"#given a filled control that becomes %s #when completing fill #then refuses success",
		async (state) => {
			const result = await pageScenario(`
				elements=[control];
				const observation=pageRuntime({method:'observe'});
				pageRuntime({method:'focus',revision:observation.revision,ref:observation.rows[0].ref,selectAll:true,text:'Done'});
				control.value='Done';
				${state === "hidden" ? "control.hidden=true" : "control.isConnected=false"};
				const result=pageRuntime({method:'fillComplete'});
				for(const callback of timers.values())callback();
				return await result;
			`);
			expect(result).not.toEqual({ ok: true });
		},
	);

	it("#given a matching filled value #when completing fill #then waits for DOM quiet and succeeds", async () => {
		const result = await pageScenario(`
			elements=[control];
			const observation=pageRuntime({method:'observe'});
			pageRuntime({method:'focus',revision:observation.revision,ref:observation.rows[0].ref,selectAll:true,text:'Done'});
			control.value='Done';
			const completed=pageRuntime({method:'fillComplete'});
			for(const callback of timers.values())callback();
			return await completed;
		`);
		expect(result).toEqual({ ok: true });
	});

	it("#given a huge credentialed URL #when observing #then bounds only its sanitized URL", async () => {
		const result = observationSchema.parse(
			await pageScenario(`
			location.pathname='/'+ 'a'.repeat(9000);
			location.href='https://user:secret@example.com'+location.pathname+'?token=secret#secret';
			return pageRuntime({method:'observe'});
		`),
		);
		expect(result.url).toHaveLength(8192);
		expect(result.url).toBe(`https://example.com/${"a".repeat(8192 - "https://example.com/".length)}`);
		expect(observationSchema.safeParse({ ...result, url: `${result.url}a` }).success).toBe(false);
	});
});

describe("page runtime select", () => {
	it("#given a native select #when choosing by label #then sets the option and reports it", async () => {
		const result = await pageScenario(`
			const select=new Element(); select.tagName='SELECT';
			select.options=[
				{value:'us',label:'United States',disabled:false},
				{value:'ca',label:'Canada',disabled:false}
			];
			select.selectedIndex=0;
			Object.defineProperty(select,'value',{
				get(){return this.options[this.selectedIndex].value},
				set(next){this.selectedIndex=this.options.findIndex((option)=>option.value===next)}
			});
			elements=[select];
			const observation=pageRuntime({method:'observe'});
			return pageRuntime({method:'selectOption',revision:observation.revision,ref:observation.rows[0].ref,choice:{label:'Canada'}});
		`);
		expect(result).toEqual({ ok: true, value: "ca", label: "Canada" });
	});

	it("#given a label that matches no option #when selecting #then refuses instead of guessing", async () => {
		const result = await pageScenario(`
			const select=new Element(); select.tagName='SELECT';
			select.options=[{value:'us',label:'United States',disabled:false}];
			select.selectedIndex=0;
			elements=[select];
			const observation=pageRuntime({method:'observe'});
			return pageRuntime({method:'selectOption',revision:observation.revision,ref:observation.rows[0].ref,choice:{label:'Mexico'}});
		`);
		expect(result).toEqual({ error: "requested option was not found" });
	});
});

const pairingSchema = z.object({
	stored: z.function({ input: z.tuple([]), output: z.unknown() }),
	nativeCalls: z.function({ input: z.tuple([]), output: z.number() }),
	socket: z.function({ input: z.tuple([z.number()]), output: z.promise(z.number()) }),
	fire: z.function({ input: z.tuple([z.number(), z.string(), z.unknown()]), output: z.void() }),
	sent: z.function({ input: z.tuple([z.number()]), output: z.array(z.unknown()) }),
	reloads: z.function({ input: z.tuple([]), output: z.number() }),
});

const STALE_TOKEN = "a".repeat(64);
const FRESH_TOKEN = "b".repeat(64);

async function pairingHarness() {
	const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
	// Chrome and the socket are the external boundary; the shipped worker's connect path runs unchanged.
	const script = new Script(`
		const pageRuntime = () => {};
		const store = { port: 47953, token: '${STALE_TOKEN}' };
		const sockets = [];
		const waiters = [];
		const changeListeners = [];
		let nativeCalls = 0;
		let reloads = 0;
		const sessionStore = {};
		const event = { addListener() {}, removeListener() {} };
		class WebSocket {
			static CONNECTING = 0;
			static OPEN = 1;
			constructor(url) {
				this.url = url; this.readyState = 0; this.listeners = {}; this.sent = [];
				sockets.push(this);
				for (const waiter of waiters.splice(0)) waiter();
			}
			addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
			send(raw) { this.sent.push(JSON.parse(raw)); }
			close() {}
		}
		const chrome = {
			storage: {
				local: {
					get: async () => ({ ...store }),
					set: async (value) => {
						const changes = {};
						for (const key of Object.keys(value)) changes[key] = { oldValue: store[key], newValue: value[key] };
						Object.assign(store, value);
						for (const listener of changeListeners) listener(changes, 'local');
					},
				},
				session: {
					get: async (key) => (key in sessionStore ? { [key]: sessionStore[key] } : {}),
					set: async (value) => { Object.assign(sessionStore, value); },
					remove: async () => {},
				},
				onChanged: { addListener(listener) { changeListeners.push(listener); } },
			},
			action: { setBadgeText: async () => {}, setTitle: async () => {} },
			runtime: {
				sendNativeMessage: async () => { nativeCalls++; return { port: 47953, token: '${FRESH_TOKEN}' }; },
				onMessage: event,
				reload: () => { reloads++; },
			},
			alarms: { create() {}, onAlarm: event },
			windows: { onRemoved: event, onFocusChanged: event, onBoundsChanged: event },
			tabs: { onRemoved: event, onAttached: event, onUpdated: event },
			debugger: { onEvent: event, onDetach: event },
		};
		${source.replace(/^import .*$/m, "")}
		({
			stored: () => store.token,
			nativeCalls: () => nativeCalls,
			socket: (index) => sockets.length > index
				? Promise.resolve(index)
				: new Promise((resolve) => waiters.push(() => { if (sockets.length > index) resolve(index); })),
			fire: (index, type, value) => {
				const ws = sockets[index];
				ws.readyState = type === 'open' ? 1 : type === 'close' ? 3 : ws.readyState;
				for (const listener of ws.listeners[type] ?? []) listener(value);
			},
			sent: (index) => sockets[index].sent,
			reloads: () => reloads,
		})
	`);
	const value: unknown = script.runInNewContext({
		setTimeout,
		clearTimeout,
		setInterval: () => 0,
		clearInterval: () => undefined,
		URL,
	});
	return pairingSchema.parse(value);
}

describe("background worker pairing", () => {
	it("#given the daemon's build #when a later pairing names another build #then the extension reloads itself once", async () => {
		const worker = await pairingHarness();
		await worker.socket(0);
		worker.fire(0, "open", {});
		worker.fire(0, "message", { data: JSON.stringify({ ready: true, build: "build-a" }) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		worker.fire(0, "message", { data: JSON.stringify({ ready: true, build: "build-a" }) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(worker.reloads()).toBe(0);
		worker.fire(0, "message", { data: JSON.stringify({ ready: true, build: "build-b" }) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(worker.reloads()).toBe(1);
	});

	it("#given a stored token the daemon no longer accepts #when it refuses the pairing #then refetches the token from the native host and reconnects with it", async () => {
		const worker = await pairingHarness();
		await worker.socket(0);
		worker.fire(0, "open", {});
		expect(worker.sent(0)).toEqual([{ token: STALE_TOKEN }]);
		worker.fire(0, "close", { code: 1008, reason: "Invalid pairing" });
		expect(worker.nativeCalls()).toBe(1);
		await worker.socket(1);
		expect(worker.stored()).toBe(FRESH_TOKEN);
		worker.fire(1, "open", {});
		expect(worker.sent(1)).toEqual([{ token: FRESH_TOKEN }]);
	});

	it("#given an ordinary disconnect #when the socket closes #then keeps the stored token without asking the native host", async () => {
		const worker = await pairingHarness();
		await worker.socket(0);
		worker.fire(0, "open", {});
		worker.fire(0, "close", { code: 1006, reason: "" });
		expect(worker.nativeCalls()).toBe(0);
		expect(worker.stored()).toBe(STALE_TOKEN);
	});
});

describe("page runtime target ranking", () => {
	it("#given several name matches #when finding #then ranks the exact interactive control first", async () => {
		const result = await pageScenario(`
			const loose=new Element(); loose.innerText='Need help to sign in?';
			const prefix=new Element(); prefix.innerText='Sign in with Google';
			const exact=new Element(); exact.innerText='Sign in';
			for(const element of [loose,prefix,exact]) element.getAttribute=()=>null;
			elements=[loose,prefix,exact];
			return pageRuntime({method:'find',query:{name:'Sign in'},limit:3});
		`);
		const found = z.object({ matches: z.array(z.object({ name: z.string() })) }).parse(result);
		expect(found.matches.map((match) => match.name)).toEqual([
			"Sign in",
			"Sign in with Google",
			"Need help to sign in?",
		]);
	});
});
