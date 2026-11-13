const $ = id => document.getElementById(id)
function render({ notes, limit }) {
  $('count').textContent = notes.length ? `${notes.length} / ${limit} 条` : '还没有便签'
  $('notes').replaceChildren(...notes.map(n => {
    const li = document.createElement('li')
    const text = document.createElement('span')
    text.textContent = n.text
    const del = document.createElement('button')
    del.textContent = '删除'
    del.onclick = () => run('remove', { id: n.id })
    li.append(text, del)
    return li
  }))
}
async function run(name, input) {
  $('error').textContent = ''
  try { render(await nuonuo.call(name, input)) } catch (e) { $('error').textContent = e.message }
}
$('add').onsubmit = e => { e.preventDefault(); const text = $('text').value; $('text').value = ''; run('add', { text }) }
run('list')
