import type {Frame} from 'puppeteer-core';
import {setTimeout as delay} from 'node:timers/promises';
export type SearchFilters = {degree:string;schools:string[];experience:string;activity:string;jobChanges:string};
export type FilterGroup = {key:keyof SearchFilters;label:string;multiple:boolean;options:string[];selected:string[]};
const presets=[{key:'degree',label:'学历要求',selector:'.degree-list-C .degree-item'},{key:'experience',label:'经验要求',selector:'.exp-list-ui .exp-item'}] as const;
const dropdowns=[{key:'activity',label:'牛人活跃度'},{key:'jobChanges',label:'跳槽频率'}] as const;
export function validateSearchFilters(input:unknown):SearchFilters {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw new Error('筛选条件必须为对象。');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!==['degree','schools','experience','activity','jobChanges'].sort().join(',')) throw new Error('筛选字段不完整或包含不支持的字段。');
  for(const key of ['degree','experience','activity','jobChanges']) if(typeof value[key]!=='string'||!value[key]||String(value[key]).length>80) throw new Error(`筛选条件 ${key} 无效。`);
  if(!Array.isArray(value.schools)||value.schools.length>20||value.schools.some(v=>typeof v!=='string'||!v||v.length>80)||new Set(value.schools).size!==value.schools.length) throw new Error('院校筛选条件无效。');
  return value as SearchFilters;
}
async function dropdown(frame:Frame,label:string,open:boolean) {
  await frame.evaluate(`(() => {
    const root=document.querySelector('input[placeholder='+${JSON.stringify(JSON.stringify(label))}+']')?.closest('.dropdown-wrap');
    if(!root) throw new Error('Boss 筛选入口不存在：'+${JSON.stringify(label)});
    if(root.classList.contains('dropdown-menu-open')!==${open}) root.querySelector('.dropdown-select').click();
  })()`);
  await delay(150);
}
export async function readSearchFilters(frame:Frame):Promise<FilterGroup[]> {
  const groups:FilterGroup[]=[];
  for(const field of presets) {
    const data=await frame.evaluate(`(() => {const nodes=Array.from(document.querySelectorAll(${JSON.stringify(field.selector)}));return {options:nodes.map(n=>n.textContent.trim()),selected:nodes.filter(n=>n.classList.contains('active')).map(n=>n.textContent.trim())};})()`) as {options:string[];selected:string[]};
    if(!data.options.length||data.selected.length!==1) throw new Error(`Boss ${field.label} 当前为自定义范围或页面结构变化；请在 Boss 选择预设项后重试。`);
    groups.push({...data,key:field.key,label:field.label,multiple:false});
  }
  const school=await frame.evaluate(`(() => {const nodes=Array.from(document.querySelectorAll('.school-ui .school-item label'));return {options:nodes.map(n=>n.textContent.trim()),selected:nodes.filter(n=>n.classList.contains('checked')).map(n=>n.textContent.trim())}})()`) as {options:string[];selected:string[]};
  if(!school.options.length) throw new Error('Boss 院校筛选选项未加载。');
  groups.splice(1,0,{...school,key:'schools',label:'院校要求',multiple:true});
  for(const field of dropdowns) {
    await dropdown(frame,field.label,true);
    try {
      const data=await frame.evaluate(`(() => {const root=document.querySelector('input[placeholder='+${JSON.stringify(JSON.stringify(field.label))}+']').closest('.dropdown-wrap');const nodes=Array.from(root.querySelectorAll('.options li'));return {options:nodes.map(n=>n.textContent.trim()),selected:nodes.filter(n=>n.classList.contains('selected')).map(n=>n.textContent.trim())};})()`) as {options:string[];selected:string[]};
      if(!data.options.length||data.selected.length!==1) throw new Error(`Boss ${field.label} 选项未正确加载。`);
      groups.push({...data,key:field.key,label:field.label,multiple:false});
    }finally{await dropdown(frame,field.label,false);}
  }
  return groups;
}
export async function applySearchFilters(frame:Frame,input:unknown) {
  const filters=validateSearchFilters(input);
  const groups=await readSearchFilters(frame);
  for(const group of groups) {
    const desired=group.multiple?filters.schools:[filters[group.key] as string];
    if(desired.some(value=>!group.options.includes(value))) throw new Error(`Boss ${group.label} 选项已变化，请重新打开筛选面板。`);
  }
  for(const group of groups) {
    const desired=group.multiple?filters.schools:[filters[group.key] as string];
    if(JSON.stringify([...desired].sort())===JSON.stringify([...group.selected].sort()))continue;
    if(group.key==='schools') {
      for(const option of group.options) {
        if(desired.includes(option)===group.selected.includes(option))continue;
        await frame.evaluate(`(() => {const n=Array.from(document.querySelectorAll('.school-ui .school-item label')).find(n=>n.textContent.trim()===${JSON.stringify(option)});if(!n)throw new Error('Boss 院校选项消失');n.click();})()`);
        await delay(400);
      }
    }else if(group.key==='degree'||group.key==='experience') {
      const selector=presets.find(p=>p.key===group.key)!.selector;
      await frame.evaluate(`(() => {const n=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(n=>n.textContent.trim()===${JSON.stringify(desired[0])});if(!n)throw new Error('Boss 筛选选项消失');n.click();})()`);
    }else {
      await dropdown(frame,group.label,true);
      await frame.evaluate(`(() => {const root=document.querySelector('input[placeholder='+${JSON.stringify(JSON.stringify(group.label))}+']').closest('.dropdown-wrap');const n=Array.from(root.querySelectorAll('.options li')).find(n=>n.textContent.trim()===${JSON.stringify(desired[0])});if(!n)throw new Error('Boss 下拉选项消失');n.click();})()`);
    }
    await delay(600);
  }
  const actual=await readSearchFilters(frame);
  for(const group of actual) {
    const desired=group.multiple?filters.schools:[filters[group.key] as string];
    if(JSON.stringify([...desired].sort())!==JSON.stringify([...group.selected].sort())) throw new Error(`Boss ${group.label} 未生效：期望 ${desired.join('、')||'不限'}，实际 ${group.selected.join('、')||'不限'}。`);
  }
  return actual;
}
